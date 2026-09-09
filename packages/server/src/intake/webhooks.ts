import { ingestChannelDelivery, ingestSecurityDelivery, validateWritePlan } from "@sdlc/core";
import { validate, type ClaudeSecurityDelivery, type ClaudeTagDelivery } from "@sdlc/schemas";
import { commitWritePlan, SYSTEM_IDENTITY } from "@sdlc/adapter-git";
import { verifyWebhookSignature } from "@sdlc/adapter-github";
import type { Delivery, DeliveryLog } from "../github/webhooks.js";
import type { StateStore } from "../store.js";

/**
 * Maintain intake receivers (build-order 3.5): Claude Security findings and
 * Claude Tag channel messages, each an open route with its own HMAC secret.
 * The receiver checks the signature over the raw body, validates the
 * envelope, dedupes by delivery id in the disposable cache, and hands the
 * validated payload to core; sdlc-bot commits the write-plan.
 */

export type IntakeKind = "claude-security" | "claude-tag";

export const INTAKE_SECRET_VAR: Record<IntakeKind, string> = {
  "claude-security": "SDLC_CLAUDE_SECURITY_WEBHOOK_SECRET",
  "claude-tag": "SDLC_CLAUDE_TAG_WEBHOOK_SECRET",
};

const SCHEMA_OF = { "claude-security": "claude-security-delivery", "claude-tag": "claude-tag-delivery" } as const;

export interface IntakeDeps {
  store: StateStore;
  /** Processed deliveries (replay guard); the receiver is off without it. */
  deliveries: DeliveryLog | null;
  env: Record<string, string | undefined>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface IntakeHeaders {
  /** `X-Hub-Signature-256: sha256=<hmac hex over the raw body>` — the same discipline as the GitHub receiver. */
  signature: string | undefined;
}

export interface ReceivedIntake {
  status: number;
  body: Record<string, unknown>;
}

const MAX_BODY = 1024 * 1024;

/** One intake commit at a time per product, so two deliveries cannot allocate the same id. */
const chains = new WeakMap<StateStore, Promise<unknown>>();
function serialize<T>(store: StateStore, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(store) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(store, next.catch(() => undefined));
  return next;
}

/** Whether a kind's receiver is on: its secret is set and the delivery log exists. */
export function intakeStatus(kind: IntakeKind, deps: Pick<IntakeDeps, "deliveries" | "env">): { path: string; secretVar: string; secretSet: boolean; enabled: boolean } {
  const secretSet = Boolean(deps.env[INTAKE_SECRET_VAR[kind]]);
  return { path: `/api/webhooks/${kind}`, secretVar: INTAKE_SECRET_VAR[kind], secretSet, enabled: secretSet && deps.deliveries !== null };
}

/**
 * `POST /api/webhooks/claude-security` and `/api/webhooks/claude-tag`. Order:
 * secret configured → size → signature over the raw body → JSON → envelope
 * schema → replay by delivery id → core transform → validation → commit.
 * A refused transform (nothing new, duplicate message) is a 200 that records
 * the delivery; a failed commit is a 500 that does not, so a redelivery
 * reprocesses it.
 */
export async function receiveIntake(kind: IntakeKind, deps: IntakeDeps, input: { headers: IntakeHeaders; body: Buffer }): Promise<ReceivedIntake> {
  const secret = deps.env[INTAKE_SECRET_VAR[kind]];
  if (!secret) return { status: 503, body: { error: `${kind} intake is off: set ${INTAKE_SECRET_VAR[kind]} in the environment of sdlc serve` } };
  if (input.body.length > MAX_BODY) return { status: 413, body: { error: "payload too large" } };
  if (!verifyWebhookSignature(secret, input.body, input.headers.signature)) return { status: 401, body: { error: "X-Hub-Signature-256 missing or invalid" } };
  if (!deps.deliveries) return { status: 503, body: { error: "intake needs the delivery log (start the server with sdlc serve)" } };
  let payload: unknown;
  try {
    payload = JSON.parse(input.body.toString("utf8"));
  } catch (e) {
    return { status: 400, body: { error: `invalid JSON body: ${(e as Error).message}` } };
  }
  const checked = validate(SCHEMA_OF[kind], payload);
  if (!checked.ok) return { status: 400, body: { error: `not a ${SCHEMA_OF[kind]} envelope (schema 1)`, diagnostics: checked.diagnostics } };
  const envelope = checked.value;
  const id = `${kind}:${envelope.deliveryId}`;
  const prior = deps.deliveries.get(id);
  if (prior) return { status: 200, body: { ok: true, replay: true, delivery: prior } };
  const receivedAt = (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const deliveries = deps.deliveries;
  return serialize(deps.store, async () => {
    const again = deliveries.get(id);
    if (again) return { status: 200, body: { ok: true, replay: true, delivery: again } };
    let outcome: string;
    let status = 200;
    let result: Record<string, unknown>;
    try {
      const r = await ingest(kind, deps.store, envelope, receivedAt);
      outcome = r.outcome;
      result = r.result;
    } catch (e) {
      deps.log?.(`[intake] ${id}: ${(e as Error).message}`);
      return { status: 500, body: { error: (e as Error).message, delivery: id } };
    }
    if (outcome.startsWith("rejected")) status = 422;
    const delivery: Delivery = { id, event: kind, action: kind === "claude-security" ? `run ${(envelope as ClaudeSecurityDelivery).run.id}` : `message ${(envelope as ClaudeTagDelivery).message.id}`, receivedAt, status, outcome, changeId: null };
    deliveries.record(delivery);
    deps.log?.(`[intake] ${id}: ${outcome}`);
    return { status, body: { ok: status === 200, replay: false, delivery, ...result } };
  });
}

/** The transform and commit shared by the receivers and `sdlc ingest`; the caller has validated the envelope. */
export async function ingest(kind: IntakeKind, store: StateStore, envelope: ClaudeSecurityDelivery | ClaudeTagDelivery, now: string): Promise<{ outcome: string; result: Record<string, unknown>; commit: string | null }> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new Error("repository not loaded");
  if (kind === "claude-security") {
    const r = ingestSecurityDelivery(repo, envelope as ClaudeSecurityDelivery, { now });
    if (!r.ok) return { outcome: `no-op: ${r.diagnostics[0]?.message ?? "nothing new"}`, result: { ingest: r.ingest ?? null }, commit: null };
    const report = validateWritePlan(repo, r.plan);
    if (report.blocking) return { outcome: `rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`, result: { diagnostics: report.diagnostics.filter((d) => d.blocking) }, commit: null };
    const commit = await commitWritePlan(store.root, r.plan, { identity: SYSTEM_IDENTITY, ...(store.committer ? { committer: store.committer } : {}) });
    await store.refresh(true);
    const i = r.ingest;
    return { outcome: `${i?.created.length ?? 0} new, ${i?.updated.length ?? 0} updated, ${i?.resolved.length ?? 0} resolved (${commit.slice(0, 7)})`, result: { commit, ingest: i ?? null }, commit };
  }
  const r = ingestChannelDelivery(repo, envelope as ClaudeTagDelivery, { now });
  if (!r.ok) return { outcome: `no-op: ${r.diagnostics[0]?.message ?? "duplicate"}`, result: { duplicateOf: r.duplicateOf ?? null }, commit: null };
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) return { outcome: `rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`, result: { diagnostics: report.diagnostics.filter((d) => d.blocking) }, commit: null };
  const commit = await commitWritePlan(store.root, r.plan, { identity: SYSTEM_IDENTITY, ...(store.committer ? { committer: store.committer } : {}) });
  await store.refresh(true);
  return { outcome: `${r.id ?? ""} raised (${commit.slice(0, 7)})`, result: { commit, id: r.id ?? null }, commit };
}

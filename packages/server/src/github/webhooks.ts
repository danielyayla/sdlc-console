import type Database from "better-sqlite3";
import { gitHubCodeHostFrom, parseWebhook, sameRepo, verifyWebhookSignature, type Env, type WebhookHeaders } from "@sdlc/adapter-github";
import type { Engine } from "../engine/engine.js";
import type { StateStore } from "../store.js";

/** One processed delivery, kept in the disposable cache so a redelivery is a no-op. */
export interface Delivery {
  id: string;
  event: string;
  action: string | null;
  receivedAt: string;
  /** HTTP status the receiver answered with. */
  status: number;
  outcome: string;
  changeId: string | null;
}

/** Deliveries by `X-GitHub-Delivery` (SQLite, same disposable database as sessions and jobs). */
export class DeliveryLog {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, receivedAt TEXT NOT NULL, json TEXT NOT NULL)");
  }

  get(id: string): Delivery | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT json FROM deliveries WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Delivery) : null;
  }

  recent(limit = 20): Delivery[] {
    if (!this.db.open) return [];
    return (this.db.prepare("SELECT json FROM deliveries ORDER BY receivedAt DESC, rowid DESC LIMIT ?").all(limit) as { json: string }[]).map((r) => JSON.parse(r.json) as Delivery);
  }

  record(d: Delivery): void {
    if (!this.db.open) return;
    this.db.prepare("INSERT OR REPLACE INTO deliveries (id, receivedAt, json) VALUES (?, ?, ?)").run(d.id, d.receivedAt, JSON.stringify(d));
  }
}

export interface ReceiverDeps {
  store: StateStore;
  engine: Engine | null;
  deliveries: DeliveryLog | null;
  /** `GITHUB_WEBHOOK_SECRET` (receiver), `GITHUB_TOKEN` (repo identity). */
  env: Env;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ReceivedWebhook {
  status: number;
  body: Record<string, unknown>;
}

const MAX_BODY = 1024 * 1024;

/**
 * `POST /api/webhooks/github` (2.4). Order: secret configured → signature over
 * the raw body → delivery id and event present → replay → JSON → the delivery
 * names this clone's repository → engine. A failed dispatch answers 500 and is
 * not recorded, so GitHub's redelivery reprocesses it; anything the first
 * attempt already claimed (a run on a head, a gate) stays claimed.
 */
export async function receiveWebhook(deps: ReceiverDeps, input: { headers: WebhookHeaders; body: Buffer }): Promise<ReceivedWebhook> {
  const secret = deps.env["GITHUB_WEBHOOK_SECRET"];
  if (!secret) return { status: 503, body: { error: "webhook receiver is off: set GITHUB_WEBHOOK_SECRET in the environment of sdlc serve" } };
  if (input.body.length > MAX_BODY) return { status: 413, body: { error: "payload too large" } };
  if (!verifyWebhookSignature(secret, input.body, input.headers.signature)) return { status: 401, body: { error: "X-Hub-Signature-256 missing or invalid" } };
  const id = input.headers.delivery?.trim() ?? "";
  const eventName = input.headers.event?.trim() ?? "";
  if (id === "" || eventName === "") return { status: 400, body: { error: "X-GitHub-Delivery and X-GitHub-Event are required" } };
  if (!deps.engine || !deps.deliveries) return { status: 503, body: { error: "webhooks need the engine (start the server with sdlcBin)" } };
  const prior = deps.deliveries.get(id);
  if (prior) return { status: 200, body: { ok: true, replay: true, delivery: prior } };
  let payload: unknown;
  try {
    payload = JSON.parse(input.body.toString("utf8"));
  } catch (e) {
    return { status: 400, body: { error: `invalid JSON body: ${(e as Error).message}` } };
  }
  const event = parseWebhook(eventName, payload);
  const action = "action" in event ? event.action : null;
  const receivedAt = (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const repo = deps.store.currentRepo ?? (await deps.store.refresh(), deps.store.currentRepo);
  let status = 200;
  let outcome: string;
  let changeId: string | null = null;
  if (!repo || repo.config.codeHost !== "github") {
    status = 202;
    outcome = "ignored: config.codeHost is not github";
  } else {
    const host = gitHubCodeHostFrom(deps.env);
    const ours = host ? await host.repoFor(deps.store.root).catch(() => null) : null;
    if (!host) {
      status = 202;
      outcome = "ignored: GITHUB_TOKEN is not set, so the repository cannot be confirmed";
    } else if (!sameRepo(ours, event.repo)) {
      status = 202;
      outcome = `ignored: delivery is for ${event.repo ? `${event.repo.owner}/${event.repo.repo}` : "an unnamed repository"}, this clone is ${ours ? `${ours.owner}/${ours.repo}` : "not a GitHub remote"}`;
    } else {
      try {
        const r = await deps.engine.onWebhook(event);
        outcome = r.outcome;
        changeId = r.changeId;
      } catch (e) {
        deps.log?.(`[webhook] ${id} ${eventName}${action ? `.${action}` : ""}: ${(e as Error).message}`);
        return { status: 500, body: { error: (e as Error).message, delivery: id } };
      }
    }
  }
  const delivery: Delivery = { id, event: eventName, action, receivedAt, status, outcome, changeId };
  deps.deliveries.record(delivery);
  deps.log?.(`[webhook] ${eventName}${action ? `.${action}` : ""} ${id}: ${outcome}`);
  return { status, body: { ok: true, replay: false, delivery } };
}

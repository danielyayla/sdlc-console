import { commitWritePlan } from "@sdlc/adapter-git";
import { deriveChange, linkRecord, recordWriteback, requiredWritebacks, shortSha, validateWritePlan, type ArtifactIndex, type Repo, type RequiredWriteback, type WritebackOutcome } from "@sdlc/core";
import type { ActionResult } from "./actions.js";
import { SYSTEM_IDENTITY } from "./engine/codehost.js";
import { ConnectorError, connectorSpec, mcpConnector, type RecordsConnector } from "./records/connector.js";
import { ActionError, type StateStore } from "./store.js";

export interface WritebackDeps {
  /** Resolve the connector for the repository; null when `records.connector` is unset. Defaults to `.mcp.json`. */
  connector?: (root: string, repo: Repo) => RecordsConnector | null;
  /** Attempts per run (default 3) and the pause between them, doubled each time (default 2 s). */
  attempts?: number;
  backoffMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface WritebackRun {
  writeback: RequiredWriteback;
  ok: boolean;
  /** Attempts made in this run. */
  attempts: number;
  error: string | null;
  /** The ledger commit recording the outcome; null when nothing new was recorded (a repeat failure). */
  commit: string | null;
}

export function defaultConnector(root: string, repo: Repo): RecordsConnector | null {
  const spec = connectorSpec(root, repo.rawConfig?.records?.connector);
  return spec ? mcpConnector(spec) : null;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stamp(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Who the fact is attributed to: the accepting human for `accepted`, the committing actor for `committed`. */
function actorFor(repo: Repo, w: RequiredWriteback): string {
  const files = repo.changes.get(w.changeId);
  const events = files?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (w.kind === "accepted" && e.event === "gate.accepted" && e.data.artifactSha === w.sha) return e.actor.id;
    if (w.kind === "committed" && e.event === "artifact.committed" && e.data.sha === w.sha) return e.actor.id;
  }
  return SYSTEM_IDENTITY.id;
}

/**
 * Run one write-back (FR-16): call the connector up to `attempts` times, then
 * record the outcome on the change's ledger by sdlc-bot — `record.writeback.ok`
 * on success; `record.writeback.failed` on the first failure of this fact (a
 * later retry that fails again only reports, the ledger already says so).
 * The accept or commit that called for it is never touched.
 */
export async function runWriteback(store: StateStore, w: RequiredWriteback, deps: WritebackDeps = {}): Promise<WritebackRun> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const attempts = Math.max(1, deps.attempts ?? 3);
  const backoff = deps.backoffMs ?? 2_000;
  const sleep = deps.sleep ?? wait;
  let connector: RecordsConnector | null;
  let error: string | null = null;
  let made = 0;
  let url: string | undefined;
  try {
    connector = (deps.connector ?? defaultConnector)(store.root, repo);
    if (!connector) throw new ConnectorError("records.connector is not set in sdlc/config.yaml — nothing can write back", false);
  } catch (e) {
    connector = null;
    error = (e as Error).message;
  }
  if (connector) {
    const files = repo.changes.get(w.changeId);
    const title = files?.change?.title ?? w.changeId;
    for (let n = 1; n <= attempts; n++) {
      made = n;
      try {
        const r = await connector.writeBack({ system: w.record.system, id: w.record.id, changeId: w.changeId, title, artifact: w.artifact, artifactName: w.artifactName, kind: w.kind, sha: w.sha, by: actorFor(repo, w), at: stamp(deps.now), ...(w.record.url ? { url: w.record.url } : {}) });
        url = r.url;
        error = null;
        break;
      } catch (e) {
        error = (e as Error).message;
        const retryable = !(e instanceof ConnectorError) || e.retryable;
        if (!retryable || n === attempts) break;
        await sleep(backoff * 2 ** (n - 1));
      }
    }
  }
  const ok = error === null;
  // a repeat failure is already on the ledger: report it, record nothing
  if (!ok && w.state === "failed") return { writeback: w, ok, attempts: made, error, commit: null };
  const outcome: WritebackOutcome = ok
    ? { artifact: w.artifact, kind: w.kind, sha: w.sha, ok: true, ...(url ? { url } : {}) }
    : { artifact: w.artifact, kind: w.kind, sha: w.sha, ok: false, error: error ?? "unknown error" };
  const files = repo.changes.get(w.changeId);
  if (!files) throw new ActionError(404, `${w.changeId} not found`);
  const r = recordWriteback(repo, deriveChange(repo, files), outcome, store.context(deps.now ? { now: stamp(deps.now) } : {}));
  if (!r.ok) throw new ActionError(409, r.diagnostics[0]?.message ?? "write-back outcome refused", r.diagnostics);
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) throw new ActionError(409, "write-back outcome rejected by validation", report.diagnostics.filter((d) => d.blocking));
  const commit = await commitWritePlan(store.root, r.plan, { identity: SYSTEM_IDENTITY });
  await store.refresh(true);
  return { writeback: w, ok, attempts: made, error, commit };
}

/** The write-back an artifact of a change is waiting on (pending or failed), or null. */
export function outstandingWriteback(repo: Repo, changeId: string, artifact: ArtifactIndex): RequiredWriteback | null {
  const files = repo.changes.get(changeId);
  if (!files) throw new ActionError(404, `${changeId} not found`);
  const all = requiredWritebacks(repo, files).filter((w) => w.artifact === artifact);
  return all.filter((w) => w.state !== "ok").at(-1) ?? null;
}

/** "write-back failed · retry" (console button, `sdlc record retry`): run it now; 502 retryable when it fails again. */
export async function retryWritebackAction(store: StateStore, changeId: string, artifact: ArtifactIndex, deps: WritebackDeps = {}): Promise<ActionResult & { run: WritebackRun }> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const w = outstandingWriteback(repo, changeId, artifact);
  if (!w) throw new ActionError(409, `${changeId}: nothing to write back for artifact ${artifact} — it is in sync or in repo mode`);
  const run = await runWriteback(store, w, deps);
  if (!run.ok) throw new ActionError(502, `${changeId}: write-back of ${w.file} ${w.kind} ${shortSha(w.sha)} to ${w.record.system} ${w.record.id} failed · retry (${run.error ?? "unknown error"})`, [], true);
  const snapshot = store.current ?? store.rebuild();
  return { commit: run.commit ?? "", snapshot, toast: `${changeId}: ${w.file} ${w.kind} ${shortSha(w.sha)} written to ${w.record.system} ${w.record.id} · synced`, changeId, run };
}

export interface LinkRecordRequest {
  system: string;
  id: string;
  url?: string;
}

/**
 * Link a change to its record. With a connector configured the record is
 * looked up first (`record_get`) so a typo never becomes a link; its url and
 * title fill in what the caller left out.
 */
export async function linkRecordAction(store: StateStore, changeId: string, input: LinkRecordRequest, deps: WritebackDeps = {}): Promise<ActionResult> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const system = input.system.trim();
  const id = input.id.trim();
  if (system === "" || id === "") throw new ActionError(400, "a record needs a system and an id");
  let url = input.url?.trim() || undefined;
  let connector: RecordsConnector | null;
  try {
    connector = (deps.connector ?? defaultConnector)(store.root, repo);
  } catch (e) {
    throw new ActionError(409, (e as Error).message);
  }
  if (connector) {
    try {
      const info = await connector.get(system, id);
      url = url ?? info.url;
    } catch (e) {
      const retryable = !(e instanceof ConnectorError) || e.retryable;
      throw new ActionError(retryable ? 502 : 409, `${changeId}: ${system} ${id} could not be verified: ${(e as Error).message}`, [], retryable);
    }
  }
  const r = await store.act((repo2, ctx) => {
    const files = repo2.changes.get(changeId);
    if (!files) throw new ActionError(404, `${changeId} not found`);
    return linkRecord(repo2, deriveChange(repo2, files), { system, id, ...(url ? { url } : {}) }, ctx);
  });
  return { ...r, toast: `${changeId} linked to ${system} ${id}${connector ? " · verified" : ""}`, changeId };
}

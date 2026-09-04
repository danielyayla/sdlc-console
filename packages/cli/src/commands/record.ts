import { deriveChange, requiredWritebacks, shortSha, STAGES, type ArtifactIndex } from "@sdlc/core";
import type { ExternalRecord } from "@sdlc/schemas";
import { SessionRegistry, StateStore, linkRecordAction, retryWritebackAction, type ActionResult } from "@sdlc/server";
import { actingIdentity, assertHuman, repoContext, type CliContext } from "../context.js";
import { CliError, type Io } from "../io.js";

async function withStore<T>(ctx: CliContext, fn: (store: StateStore) => Promise<T>): Promise<T> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const registry = new SessionRegistry(ctx.root);
  try {
    const store = new StateStore({ root: ctx.root, identity: who, sessions: () => registry.list() });
    await store.refresh();
    return await fn(store);
  } finally {
    registry.close();
  }
}

/** `intent|spec|plan|evals|pr|incident` or the index 0–5. */
export function artifactIndexOf(arg: string | undefined): ArtifactIndex {
  const byName = STAGES.find((s) => s.artifact === arg || s.file === arg);
  if (byName) return byName.artifactIndex;
  const n = Number(arg);
  if (Number.isInteger(n) && n >= 0 && n <= 5) return n as ArtifactIndex;
  throw new CliError(`unknown artifact ${arg ?? ""}: use intent|spec|plan|evals|pr|incident`, 2);
}

/** `sdlc record link <CHG> --system <s> --id <id> [--url <u>]`: change.yaml.record + `record.linked`, verified through the connector when one is configured. */
export function recordLink(ctx: CliContext, changeId: string, input: { system: string; id: string; url?: string }): Promise<ActionResult> {
  return withStore(ctx, (store) => linkRecordAction(store, changeId, input));
}

/** `sdlc record retry <CHG> <artifact>`: run the outstanding write-back now (FR-16 "write-back failed · retry"). */
export function recordRetry(ctx: CliContext, changeId: string, artifact: ArtifactIndex): Promise<ActionResult> {
  return withStore(ctx, (store) => retryWritebackAction(store, changeId, artifact));
}

export interface RecordStatusRow {
  artifact: string;
  mode: string;
  synced: string | null;
  writeback: string | null;
}

export interface RecordStatus {
  changeId: string;
  record: ExternalRecord | null;
  connector: string | null;
  rows: RecordStatusRow[];
  block: string | null;
}

/** `sdlc record status <CHG>`: the record chip, the connector and each artifact's mode, sync time and outstanding write-back. */
export function recordStatus(ctx: CliContext, changeId: string): Promise<RecordStatus> {
  return withStore(ctx, (store) => {
    const repo = store.currentRepo;
    const files = repo?.changes.get(changeId);
    if (!repo || !files) throw new CliError(`${changeId} not found`, 2);
    const view = deriveChange(repo, files);
    const required = requiredWritebacks(repo, files);
    const rows = STAGES.map((s) => {
      const doc = view.docs[s.artifactIndex];
      const w = required.filter((x) => x.artifact === s.artifactIndex).at(-1) ?? null;
      return {
        artifact: doc.name,
        mode: doc.record.mode,
        synced: doc.record.syncedAt,
        writeback: w ? `${w.kind} ${shortSha(w.sha)} · ${w.state}${w.error ? ` (${w.error})` : ""}` : null,
      };
    });
    return Promise.resolve({ changeId, record: view.record, connector: repo.rawConfig?.records?.connector ?? null, rows, block: view.recordBlock });
  });
}

const USAGE = "usage: sdlc record link <CHG> --system <s> --id <id> [--url <u>] | sdlc record retry <CHG> <artifact> | sdlc record status <CHG>";

export async function recordCommand(io: Io, sub: string | undefined, rest: string[], values: Record<string, string | boolean | undefined>, json: boolean): Promise<{ value: unknown; text: string }> {
  const ctx = await repoContext(io, json);
  const changeId = rest[0];
  if (sub === "link" && changeId) {
    const system = typeof values["system"] === "string" ? values["system"] : "";
    const id = typeof values["id"] === "string" ? values["id"] : "";
    if (system === "" || id === "") throw new CliError(`--system and --id are required\n${USAGE}`, 2);
    const url = typeof values["url"] === "string" ? values["url"] : undefined;
    const r = await recordLink(ctx, changeId, { system, id, ...(url ? { url } : {}) });
    return { value: r, text: `${r.toast} · ${r.commit.slice(0, 7)}` };
  }
  if (sub === "retry" && changeId) {
    const r = await recordRetry(ctx, changeId, artifactIndexOf(rest[1]));
    return { value: r, text: `${r.toast}${r.commit ? ` · ${r.commit.slice(0, 7)}` : ""}` };
  }
  if (sub === "status" && changeId) {
    const s = await recordStatus(ctx, changeId);
    const lines = [
      `${s.changeId}  record: ${s.record ? `${s.record.system} ${s.record.id}${s.record.url ? ` (${s.record.url})` : ""}` : "none"}  connector: ${s.connector ?? "none"}`,
      ...s.rows.map((r) => `  ${r.artifact.padEnd(12)} ${r.mode.padEnd(9)} synced ${r.synced ?? "never"}${r.writeback ? `  write-back ${r.writeback}` : ""}`),
      ...(s.block ? [`  ${s.block}`] : []),
    ];
    return { value: s, text: lines.join("\n") };
  }
  throw new CliError(USAGE);
}

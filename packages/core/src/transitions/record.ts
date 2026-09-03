import { stringifyYaml, type Change, type WritebackKind } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import { lastEvent } from "../events.js";
import { externalArtifacts, shortSha } from "../records.js";
import type { Repo } from "../repo.js";
import type { ArtifactIndex } from "../stages.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, SYSTEM_ACTOR, trailersFor, type TransitionContext } from "./context.js";

export interface LinkRecordInput {
  system: string;
  id: string;
  url?: string;
}

/**
 * Link a change to its external record (FR-16): `change.yaml.record` plus a
 * `record.linked` event, by a product owner or engineer. A record is linked
 * once — the console never re-points a change at another record.
 */
export function linkRecord(repo: Repo, view: ChangeView, input: LinkRecordInput, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing — roles cannot be verified");
  const role = (["po", "eng", "platform"] as const).find((r) => holdsRole(repo.config, ctx.actor.id, r));
  if (!role) return refuse("record.not-owner", `${ctx.actor.id} holds none of the roles that link records (po, eng, platform)`);
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (files.change.closed) return refuse("change.closed", `${view.id} is closed`);
  const system = input.system.trim();
  const id = input.id.trim();
  if (system === "" || id === "") return refuse("record.ref-missing", "a record needs a system and an id", `${files.dir}/change.yaml`);
  if (files.change.record) return refuse("record.exists", `${view.id} is already linked to ${files.change.record.system} ${files.change.record.id}`, `${files.dir}/change.yaml`);
  const url = input.url?.trim();
  const record = { system, id, ...(url ? { url } : {}) };
  const change: Change = { ...files.change, record };
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("record.linked", role, files.change.cycle, record);
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path: `${files.dir}/change.yaml`, content: stringifyYaml(change) }],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): link record ${system} ${id}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role },
  };
  return { ok: true, plan };
}

export type WritebackOutcome =
  | { artifact: ArtifactIndex; kind: WritebackKind; sha: string; ok: true; url?: string }
  | { artifact: ArtifactIndex; kind: WritebackKind; sha: string; ok: false; error: string };

/**
 * Record what the connector answered (system actor): `record.writeback.ok`
 * or `record.writeback.failed` for one artifact fact. The accept or commit
 * that called for the write-back is never touched — failure is visible, not
 * fatal (FR-16).
 */
export function recordWriteback(repo: Repo, view: ChangeView, outcome: WritebackOutcome, ctx: TransitionContext): TransitionResult {
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const record = files.change.record;
  if (!record) return refuse("writeback.record-missing", `${view.id} has no record to write back to`, `${files.dir}/change.yaml`);
  const doc = view.docs[outcome.artifact];
  if (repo.config.records[doc.record.artifactName] === "repo") return refuse("writeback.repo-mode", `${doc.name} is authoritative in the repository; nothing is written back`, doc.path);
  const already = lastEvent(files.events, "record.writeback.ok", (e) => e.data.artifact === outcome.artifact && e.data.kind === outcome.kind && e.data.sha === outcome.sha);
  if (already) return refuse("writeback.recorded", `${doc.name} ${outcome.kind} at ${shortSha(outcome.sha)} was already written to ${record.system} ${record.id}`, doc.path);
  const ev = new EventBuilder(ctx, files, view.id);
  const base = { system: record.system, id: record.id, artifact: outcome.artifact, kind: outcome.kind, sha: outcome.sha };
  const event = outcome.ok
    ? ev.system("record.writeback.ok", files.change.cycle, { ...base, ...(outcome.url ? { url: outcome.url } : {}) })
    : ev.system("record.writeback.failed", files.change.cycle, { ...base, error: outcome.error });
  const plan: WritePlan = {
    changeId: view.id,
    files: [],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): write-back ${outcome.ok ? "ok" : "failed"} — ${doc.name} ${outcome.kind} ${shortSha(outcome.sha)} → ${record.system} ${record.id}`,
    trailers: { "SDLC-Event": event.id, "SDLC-Actor": `system:${SYSTEM_ACTOR.id}` },
    actor: { type: "system", id: SYSTEM_ACTOR.id },
  };
  return { ok: true, plan };
}

/** Artifacts of this repository that a record is needed for, for messages. */
export function recordNeededFor(repo: Repo): string {
  return externalArtifacts(repo).join(", ");
}

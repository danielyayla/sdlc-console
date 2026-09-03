import type { ArtifactName, ExternalRecord, RecordsMode, WritebackKind } from "@sdlc/schemas";
import { eventsNamed, lastEvent } from "./events.js";
import type { ChangeFiles, Repo } from "./repo.js";
import { STAGES, type ArtifactIndex } from "./stages.js";

/**
 * Records mode (FR-16, spec 5A.6). `records.<artifact>` in `sdlc/config.yaml`
 * says who is authoritative for each artifact: `repo` (the file), `external`
 * (the system of record — the file is a synced copy) or `linked` (the file,
 * but the record must carry the artifact's commit sha before the gate is
 * decided). Everything here is derived from the ledger: a write-back the
 * connector still owes is a commit or an accept of such an artifact with no
 * `record.writeback.ok` for the same artifact, kind and sha.
 */

export type WritebackState = "pending" | "ok" | "failed";

export type RecordRef = ExternalRecord;

export interface RequiredWriteback {
  changeId: string;
  artifact: ArtifactIndex;
  artifactName: ArtifactName;
  file: string;
  mode: "external" | "linked";
  kind: WritebackKind;
  sha: string;
  record: RecordRef;
  /** When the fact happened (the accept or the commit). */
  triggeredAt: string;
  state: WritebackState;
  /** Time of the outcome event; null while pending. */
  at: string | null;
  error: string | null;
  url: string | null;
}

/** Linked mode needs a commit to write back; `evals` and `pr` have no `artifact.committed`, so they behave as external (validation warns). */
export function effectiveMode(repo: Repo, artifact: ArtifactName): RecordsMode {
  const mode = repo.config.records[artifact];
  if (mode === "linked" && (artifact === "evals" || artifact === "pr")) return "external";
  return mode;
}

/** Artifacts whose mode is not `repo`, in stage order. */
export function externalArtifacts(repo: Repo): ArtifactName[] {
  return STAGES.filter((s) => repo.config.records[s.artifact] !== "repo").map((s) => s.artifact);
}

/** Every write-back the ledger of one change calls for, oldest first, with what the ledger says happened to it. */
export function requiredWritebacks(repo: Repo, files: ChangeFiles): RequiredWriteback[] {
  const change = files.change;
  if (!change?.record) return [];
  const record = change.record;
  const byKey = new Map<string, RequiredWriteback>();
  for (const s of STAGES) {
    const mode = effectiveMode(repo, s.artifact);
    if (mode === "repo") continue;
    const idx = s.artifactIndex;
    const add = (kind: WritebackKind, sha: string, triggeredAt: string) => {
      const key = `${idx}:${kind}:${sha}`;
      const ok = lastEvent(files.events, "record.writeback.ok", (e) => e.data.artifact === idx && e.data.kind === kind && e.data.sha === sha);
      const failed = lastEvent(files.events, "record.writeback.failed", (e) => e.data.artifact === idx && e.data.kind === kind && e.data.sha === sha);
      const state: WritebackState = ok ? "ok" : failed && failed.ts >= triggeredAt ? "failed" : "pending";
      byKey.set(key, {
        changeId: files.id,
        artifact: idx,
        artifactName: s.artifact,
        file: s.file,
        mode,
        kind,
        sha,
        record,
        triggeredAt,
        state,
        at: ok?.ts ?? (state === "failed" ? (failed?.ts ?? null) : null),
        error: state === "failed" ? (failed?.data.error ?? null) : null,
        url: ok?.data.url ?? null,
      });
    };
    for (const e of eventsNamed(files.events, "artifact.committed")) if (e.data.artifact === idx) add("committed", e.data.sha, e.ts);
    if (s.gate !== null) {
      for (const e of eventsNamed(files.events, "gate.accepted")) if (e.data.gate === s.gate) add("accepted", e.data.artifactSha, e.ts);
    }
  }
  return [...byKey.values()].sort((a, b) => a.triggeredAt.localeCompare(b.triggeredAt));
}

/** Write-backs across the repository in a given state (the engine runs `pending`, re-tries `failed`). */
export function writebacksInState(repo: Repo, state: WritebackState): RequiredWriteback[] {
  const out: RequiredWriteback[] = [];
  for (const files of repo.changes.values()) {
    if (!files.change || files.change.closed) continue;
    for (const w of requiredWritebacks(repo, files)) if (w.state === state) out.push(w);
  }
  return out;
}

export function pendingWritebacks(repo: Repo): RequiredWriteback[] {
  return writebacksInState(repo, "pending");
}

/** Whether the record already carries this artifact commit (linked mode's precondition for accept). */
export function commitWrittenBack(files: ChangeFiles, artifact: ArtifactIndex, sha: string): boolean {
  return lastEvent(files.events, "record.writeback.ok", (e) => e.data.artifact === artifact && e.data.kind === "committed" && e.data.sha === sha) !== null;
}

/** The error of the latest failed write-back of this artifact commit, when no success followed it; null otherwise. */
export function commitWritebackFailure(files: ChangeFiles, artifact: ArtifactIndex, sha: string): string | null {
  if (commitWrittenBack(files, artifact, sha)) return null;
  return lastEvent(files.events, "record.writeback.failed", (e) => e.data.artifact === artifact && e.data.kind === "committed" && e.data.sha === sha)?.data.error ?? null;
}

/** Latest successful write-back of an artifact — the "synced" time in the viewer header. */
export function syncedAt(files: ChangeFiles, artifact: ArtifactIndex): string | null {
  return lastEvent(files.events, "record.writeback.ok", (e) => e.data.artifact === artifact)?.ts ?? null;
}

export function recordLabel(record: RecordRef | null): string | null {
  return record ? `${record.system} ${record.id}` : null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

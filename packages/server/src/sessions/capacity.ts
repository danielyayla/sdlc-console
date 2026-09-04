import type { ChangeView, Repo } from "@sdlc/core";
import { deriveChange } from "@sdlc/core";
import type { SessionRecord } from "../snapshot.js";

/** FR-35: "N active · review backlog M"; over the ceiling, no new session starts. */
export interface Capacity {
  active: number;
  /** Sessions done and awaiting review. */
  backlog: number;
  /** `null` = no ceiling (config `thresholds.sessionCeiling: null`). */
  ceiling: number | null;
  over: boolean;
}

const ARTIFACT_STAGE: Record<string, number> = { intent: 1, design: 2, plan: 3 };

/**
 * A finished session waits for review until its output was judged: a build or
 * review session until a green run / mirror covered it (`reviewed`), an
 * artifact session until the gate its artifact opened is decided, and any
 * session until its change merges. Runtime records only — nothing is stored.
 */
export function awaitingReview(s: SessionRecord, view: ChangeView | null): boolean {
  if (s.status !== "done") return false;
  if (!view || view.closed || view.stage >= 6) return false;
  if (s["reviewed"] === true) return false;
  const kind = typeof s["kind"] === "string" ? s["kind"] : "build";
  const artifactStage = ARTIFACT_STAGE[kind];
  if (artifactStage !== undefined) return view.stage <= artifactStage;
  return true;
}

export function sessionCapacity(sessions: readonly SessionRecord[], viewOf: (changeId: string) => ChangeView | null, ceiling: number | null): Capacity {
  const active = sessions.filter((s) => s.status === "running" || s.status === "waiting").length;
  const backlog = sessions.filter((s) => awaitingReview(s, viewOf(s.changeId))).length;
  return { active, backlog, ceiling, over: ceiling !== null && backlog > ceiling };
}

/** Capacity over a repo, deriving only the changes the sessions reference. */
export function capacityOf(sessions: readonly SessionRecord[], repo: Repo): Capacity {
  const cache = new Map<string, ChangeView | null>();
  const viewOf = (id: string): ChangeView | null => {
    if (!cache.has(id)) {
      const files = repo.changes.get(id);
      cache.set(id, files ? deriveChange(repo, files) : null);
    }
    return cache.get(id) ?? null;
  };
  return sessionCapacity(sessions, viewOf, repo.config.thresholds.sessionCeiling);
}

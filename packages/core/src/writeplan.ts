import { stringifyJsonl, type Diagnostic, type Event } from "@sdlc/schemas";
import { normalizePath, syntheticSha, type Tree } from "./tree.js";

export interface FileWrite {
  path: string;
  /** null deletes the file. */
  content: string | null;
}

export interface EventWrite {
  changeId: string;
  event: Event;
}

/**
 * Everything a transition wants committed, as data. Only the git adapter
 * turns this into a commit; the filesystem adapter and tests apply it to a
 * tree with `applyWritePlan`.
 */
export interface WritePlan {
  /** The change this plan is about; null for plans that touch no change (e.g. a triage dismissal). */
  changeId: string | null;
  files: FileWrite[];
  /** Appended, in order, to `sdlc/changes/<changeId>/log.jsonl`. */
  events: EventWrite[];
  commitMessage: string;
  /** Commit trailers, e.g. `SDLC-Event`, `SDLC-Actor`. */
  trailers: Record<string, string>;
  actor: Event["actor"];
}

export type TransitionResult = { ok: true; plan: WritePlan } | { ok: false; diagnostics: Diagnostic[] };

export function refuse(rule: string, message: string, path = ""): TransitionResult {
  return { ok: false, diagnostics: [{ path, severity: "error", rule, message }] };
}

export function logPath(changeId: string): string {
  return `sdlc/changes/${changeId}/log.jsonl`;
}

/** Apply a plan to a snapshot: deletes, then writes, then event appends. Pure; returns a new tree. */
export function applyWritePlan(tree: Tree, plan: WritePlan): Tree {
  const files = new Map(tree.files);
  for (const f of plan.files.filter((x) => x.content === null)) files.delete(normalizePath(f.path));
  for (const f of plan.files) {
    if (f.content !== null) files.set(normalizePath(f.path), { content: f.content, sha: syntheticSha(f.content) });
  }
  const byChange = new Map<string, Event[]>();
  for (const e of plan.events) {
    const list = byChange.get(e.changeId) ?? [];
    list.push(e.event);
    byChange.set(e.changeId, list);
  }
  for (const [changeId, events] of byChange) {
    const path = logPath(changeId);
    const existing = files.get(path)?.content ?? "";
    const content = existing + stringifyJsonl(events);
    files.set(path, { content, sha: syntheticSha(content) });
  }
  return { ref: tree.ref, files };
}

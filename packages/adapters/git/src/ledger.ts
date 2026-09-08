import { dedupeEvents, logPath, sortEvents } from "@sdlc/core";
import { parseJsonl, type Diagnostic, type Event } from "@sdlc/schemas";
import { commitTrailers, fileHistory } from "./commit.js";
import { gitRaw, localBranches } from "./git.js";

export interface LedgerUnion {
  events: Event[];
  /** Branches that carried at least one event for the change. */
  branches: string[];
  diagnostics: Diagnostic[];
}

/**
 * `log.jsonl` across every local branch, deduplicated by event id and ordered
 * by seq (docs/storage-layout.md: merge=union, ids make replay idempotent).
 */
export async function readLedgerUnion(dir: string, changeId: string, refs?: readonly string[]): Promise<LedgerUnion> {
  const branches = refs ? [...refs] : await localBranches(dir);
  const path = logPath(changeId);
  const events: Event[] = [];
  const carrying: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const ref of branches) {
    const r = await gitRaw(dir, ["show", `${ref}:${path}`]);
    if (r.code !== 0) continue;
    const parsed = parseJsonl(r.stdout, `${ref}:${path}`);
    diagnostics.push(...parsed.diagnostics);
    const good = parsed.value ?? lenient(r.stdout, `${ref}:${path}`);
    if (good.length > 0) carrying.push(ref);
    events.push(...good);
  }
  return { events: sortEvents(dedupeEvents(events)), branches: carrying, diagnostics };
}

function lenient(text: string, path: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const r = parseJsonl(line, path);
    if (r.value) out.push(...r.value);
  }
  return out;
}

/** Change ids present on each local branch, for `validateIds`. */
export async function changeIdsByRef(dir: string, refs?: readonly string[]): Promise<Record<string, string[]>> {
  const branches = refs ? [...refs] : await localBranches(dir);
  const out: Record<string, string[]> = {};
  for (const ref of branches) {
    const r = await gitRaw(dir, ["ls-tree", "--name-only", `${ref}:sdlc/changes`]);
    out[ref] = r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^CHG-\d{4}$/.test(s)) : [];
  }
  return out;
}

/**
 * The commit carrying each ledger event's `SDLC-Event` trailer, by event id,
 * from the history of the change's `log.jsonl` at `ref` (the same chain
 * `sdlc audit` verifies). Events whose commit is not in this clone are absent.
 */
export async function ledgerCommits(dir: string, changeId: string, ref = "HEAD"): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of await fileHistory(dir, logPath(changeId), ref)) {
    const t = await commitTrailers(dir, c.sha);
    const evId = t["SDLC-Event"];
    if (evId && !(evId in out)) out[evId] = c.sha;
  }
  return out;
}

import type { Proposal } from "@sdlc/schemas";
import { PATHS } from "./fingerprint.js";
import type { Repo } from "./repo.js";
import { readFile } from "./tree.js";

/**
 * Repeat-mistake signal (FR-43, spec 5A.2, playbook "make the same mistake
 * twice → add a line to CLAUDE.md"): pure derivation over every change's
 * ledger. Reasons are normalised (lowercase, trimmed, one space) and grouped
 * per repository; a proposal answering a reason is found by its `reason`.
 */

export function normalizeReason(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A short stable key for a reason (job keys, branch names); core has no crypto, so djb2 in hex. */
export function reasonKey(reason: string): string {
  let h = 5381;
  const s = normalizeReason(reason);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export interface RepeatOccurrence {
  changeId: string;
  cycle: number;
  event: "hook.blocked" | "gate.sent_back";
  ts: string;
  /** The agent session the hook blocked, or null for a send-back. */
  session: string | null;
  /** Hook name, or the gate number for a send-back. */
  via: string;
  raw: string;
}

export interface RepeatSignal {
  /** Normalised reason. */
  reason: string;
  /** The reason as first written. */
  display: string;
  /** Distinct occurrences: one per session for hook blocks, one per decision for send-backs. */
  count: number;
  /** Change ids, first seen first. */
  citations: string[];
  occurrences: RepeatOccurrence[];
  firstAt: string;
  lastAt: string;
  /** The proposal answering this reason, whatever its status; null when none was filed yet. */
  proposal: { id: string; status: Proposal["status"] } | null;
}

/** The proposal that answers a normalised reason (the newest, by creation). */
export function proposalForReason(proposals: readonly Proposal[], reason: string): Proposal | null {
  const r = normalizeReason(reason);
  return [...proposals].filter((p) => p.reason !== undefined && normalizeReason(p.reason) === r).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * Reasons cited by two or more hook blocks / send-backs across sessions
 * (`minCount`). A session hammering the same edit counts once; every
 * send-back is a separate human decision and counts on its own.
 */
export function repeatSignals(repo: Pick<Repo, "changes" | "proposals">, minCount = 2): RepeatSignal[] {
  const groups = new Map<string, { display: string; sources: Set<string>; occurrences: RepeatOccurrence[] }>();
  for (const files of repo.changes.values()) {
    for (const e of files.events) {
      let raw: string;
      let session: string | null = null;
      let via: string;
      let source: string;
      if (e.event === "hook.blocked") {
        raw = e.data.reason;
        session = e.actor.type === "agent" ? e.actor.session : null;
        via = e.data.hook;
        source = `hook:${session ?? `${files.id}:${e.cycle}`}`;
      } else if (e.event === "gate.sent_back") {
        raw = e.data.feedback;
        via = `gate ${e.data.gate}`;
        source = `sent-back:${e.id}`;
      } else continue;
      const reason = normalizeReason(raw);
      if (reason === "") continue;
      const g = groups.get(reason) ?? { display: raw.trim(), sources: new Set<string>(), occurrences: [] };
      if (g.sources.has(source)) continue;
      g.sources.add(source);
      g.occurrences.push({ changeId: files.id, cycle: e.cycle, event: e.event, ts: e.ts, session, via, raw: raw.trim() });
      groups.set(reason, g);
    }
  }
  const out: RepeatSignal[] = [];
  for (const [reason, g] of groups) {
    if (g.sources.size < minCount) continue;
    const occurrences = [...g.occurrences].sort((a, b) => a.ts.localeCompare(b.ts));
    const citations = [...new Set(occurrences.map((o) => o.changeId))];
    const p = proposalForReason(repo.proposals, reason);
    out.push({ reason, display: g.display, count: g.sources.size, citations, occurrences, firstAt: occurrences[0]?.ts ?? "", lastAt: occurrences.at(-1)?.ts ?? "", proposal: p ? { id: p.id, status: p.status } : null });
  }
  return out.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt) || a.reason.localeCompare(b.reason));
}

/** Signals no proposal answers yet: what the proposal job works on. */
export function pendingRepeatSignals(repo: Pick<Repo, "changes" | "proposals">, minCount = 2): RepeatSignal[] {
  return repeatSignals(repo, minCount).filter((s) => s.proposal === null);
}

/** The branch an accepted proposal's line waits on (docs/storage-layout.md: the console never edits CLAUDE.md on the default branch). */
export function proposalBranch(id: string): string {
  return `sdlc/proposals/${id}`;
}

/**
 * CLAUDE.md with the proposed line appended as a bullet: after the last item
 * of the first bullet list before any `##` heading (the working-knowledge
 * list), else at the end. Unchanged when the line is already there.
 */
export function appendClaudeMdLine(text: string, line: string): string {
  const bullet = `- ${line.trim()}`;
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => l.trim() === bullet || l.trim() === bullet.replace(/^- /, "* "))) return text;
  let lastBullet = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^##\s/.test(l)) break;
    if (/^\s*[-*+]\s+\S/.test(l)) lastBullet = i;
  }
  if (lastBullet >= 0) {
    lines.splice(lastBullet + 1, 0, bullet);
    return lines.join("\n");
  }
  const body = text.replace(/\s+$/, "");
  return `${body}${body === "" ? "" : "\n\n"}${bullet}\n`;
}

/** True when the default branch's CLAUDE.md already carries the proposal's line — the PR merged, or someone wrote it by hand. */
export function proposalLanded(repo: Pick<Repo, "tree">, p: Pick<Proposal, "text" | "type">): boolean {
  if (p.type !== "claude-md-line") return false;
  const text = readFile(repo.tree, PATHS.claudeMd)?.content ?? "";
  const wanted = p.text.trim();
  return text.split(/\r?\n/).some((l) => l.replace(/^\s*[-*+]\s+/, "").trim() === wanted);
}

export interface ProposalView extends Proposal {
  /** Times the reason was seen (distinct sources); 0 for a proposal without a linked reason. */
  seen: number;
  landed: boolean;
}

export function proposalViews(repo: Pick<Repo, "changes" | "proposals" | "tree">): ProposalView[] {
  const signals = repeatSignals(repo, 1);
  return repo.proposals.map((p) => ({ ...p, seen: p.reason === undefined ? 0 : (signals.find((s) => s.reason === normalizeReason(p.reason ?? ""))?.count ?? 0), landed: proposalLanded(repo, p) }));
}

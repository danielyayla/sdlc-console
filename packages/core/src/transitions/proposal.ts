import { ONE_PAGE_WORDS, countWords, stringifyYaml, type Proposal } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import { PATHS } from "../fingerprint.js";
import { nextId } from "../ids.js";
import { appendClaudeMdLine, normalizeReason, proposalBranch, proposalForReason } from "../proposals.js";
import type { Repo } from "../repo.js";
import { readFile } from "../tree.js";
import { refuse, type TransitionResult } from "../writeplan.js";
import { EventBuilder, SYSTEM_ACTOR, type TransitionContext } from "./context.js";

function isOwner(repo: Repo, actor: string): boolean {
  return holdsRole(repo.config, actor, "eng") || holdsRole(repo.config, actor, "platform");
}

/** Dismiss a CLAUDE.md / test-change proposal with a reason (FR-22, FR-43); logged on the proposal file. */
export function dismissProposal(repo: Repo, id: string, reason: string, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!isOwner(repo, ctx.actor.id)) return refuse("proposal.not-owner", `${ctx.actor.id} holds neither eng nor platform`);
  if (reason.trim() === "") return refuse("dismissal.reason-missing", "a dismissal needs a reason");
  const p = repo.proposals.find((x) => x.id === id);
  if (!p) return refuse("proposal.missing", `${id} not found`);
  if (p.status !== "open") return refuse("proposal.not-open", `${id} is ${p.status}`);
  const next: Proposal = { ...p, status: "dismissed", dismissal: { by: ctx.actor.id, reason: reason.trim(), at: ctx.now } };
  return {
    ok: true,
    plan: {
      changeId: null,
      files: [{ path: `sdlc/proposals/${id}.yaml`, content: stringifyYaml(next) }],
      events: [],
      commitMessage: `sdlc(${id}): dismiss — ${reason.trim()}`,
      trailers: { "SDLC-Actor": `human:${ctx.actor.id}` },
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

export interface FileProposalInput {
  /** One line for CLAUDE.md. */
  text: string;
  /** Change ids (and anything else worth citing). */
  citations: string[];
  /** The repeat reason this line answers (normalised on write). */
  reason: string;
  /** The agent session that proposed it; the system commits, the agent stays the author of the note. */
  agent: { id: string; session: string };
}

/**
 * File a CLAUDE.md line proposal the agent job drafted (FR-43): a new
 * `sdlc/proposals/PRP-NNNN.yaml` plus a note on the newest cited change.
 * Refused while a proposal for the same reason exists — a third occurrence
 * counts onto it; nothing here touches CLAUDE.md.
 */
export function fileProposal(repo: Repo, input: FileProposalInput, ctx: Pick<TransitionContext, "now" | "newId" | "knownIds">): TransitionResult & { proposalId?: string } {
  const text = input.text.trim();
  const reason = normalizeReason(input.reason);
  if (text === "") return refuse("proposal.text-missing", "a proposal needs the line to add");
  if (/[\r\n]/.test(text)) return refuse("proposal.multiline", "a proposal is one line for CLAUDE.md");
  if (reason === "") return refuse("proposal.reason-missing", "a proposal answers a repeat reason");
  const existing = proposalForReason(repo.proposals, reason);
  if (existing) return refuse("proposal.exists", `${existing.id} (${existing.status}) already answers "${reason}"; a new occurrence counts onto it`);
  const citations = [...new Set(input.citations.map((c) => c.trim()).filter((c) => c !== ""))];
  const claude = readFile(repo.tree, PATHS.claudeMd)?.content ?? "";
  const words = countWords(claude) + countWords(text);
  const id = nextId("PRP", [...repo.proposals.map((p) => p.id), ...(ctx.knownIds ?? [])]);
  const proposal: Proposal = { schema: 1, id, type: "claude-md-line", text, citations, reason, status: "open", createdAt: ctx.now };
  const cited = citations.find((c) => repo.changes.has(c));
  const files = cited ? repo.changes.get(cited) : undefined;
  const events = [];
  if (cited && files?.change) {
    const ev = new EventBuilder(ctx as TransitionContext, files, cited);
    events.push(ev.write(ev.agent("note", files.change.cycle, { text: `proposed CLAUDE.md line ${id} for "${reason}": ${text}${words > ONE_PAGE_WORDS ? ` (CLAUDE.md would be ${words} words, over one page)` : ""}` }, input.agent)));
  }
  return {
    ok: true,
    proposalId: id,
    plan: {
      changeId: cited ?? null,
      files: [{ path: `sdlc/proposals/${id}.yaml`, content: stringifyYaml(proposal) }],
      events,
      commitMessage: `sdlc(${id}): propose CLAUDE.md line — ${text}`,
      trailers: { ...(events[0] ? { "SDLC-Event": events[0].event.id } : {}), "SDLC-Actor": `system:${SYSTEM_ACTOR.id}`, "SDLC-Session": input.agent.session },
      actor: SYSTEM_ACTOR,
    },
  };
}

export interface AcceptCheck {
  proposal: Proposal;
  branch: string;
  /** CLAUDE.md with the line appended — what the proposal branch commits; the default branch is never written. */
  content: string;
  path: string;
}

/**
 * Preconditions for accepting a proposal and the content the branch commit
 * carries. Accepting is a human decision by an `eng` or `platform` identity;
 * the code owners decide on the PR, so nothing here merges.
 */
export function checkAcceptProposal(repo: Repo, id: string, ctx: Pick<TransitionContext, "actor">): { ok: true; check: AcceptCheck } | { ok: false; result: TransitionResult } {
  const fail = (rule: string, message: string) => ({ ok: false as const, result: refuse(rule, message, `sdlc/proposals/${id}.yaml`) });
  if (!repo.config.present) return fail("config.missing", "sdlc/config.yaml is missing");
  if (!isOwner(repo, ctx.actor.id)) return fail("proposal.not-owner", `${ctx.actor.id} holds neither eng nor platform`);
  const p = repo.proposals.find((x) => x.id === id);
  if (!p) return fail("proposal.missing", `${id} not found`);
  if (p.status !== "open") return fail("proposal.not-open", `${id} is ${p.status}`);
  if (p.type !== "claude-md-line") return fail("proposal.type", `${id} is a ${p.type} proposal; only CLAUDE.md lines are accepted into a PR here`);
  const claude = readFile(repo.tree, PATHS.claudeMd)?.content;
  if (claude === undefined) return fail("claude-md.missing", "CLAUDE.md is missing — write one first; the console only proposes lines to an existing file");
  const content = appendClaudeMdLine(claude, p.text);
  if (content === claude) return fail("proposal.landed", `CLAUDE.md already carries "${p.text}"`);
  return { ok: true, check: { proposal: p, branch: proposalBranch(id), content, path: PATHS.claudeMd } };
}

export interface AcceptedPr {
  branch: string;
  number?: number;
  url?: string;
}

/** Record the acceptance on the proposal file (default branch): status, branch and PR. The line itself is on the branch. */
export function acceptProposal(repo: Repo, id: string, pr: AcceptedPr, ctx: TransitionContext): TransitionResult {
  const pre = checkAcceptProposal(repo, id, ctx);
  if (!pre.ok) return pre.result;
  const next: Proposal = { ...pre.check.proposal, status: "accepted", pr: { branch: pr.branch, ...(pr.number !== undefined ? { number: pr.number } : {}), ...(pr.url !== undefined ? { url: pr.url } : {}) } };
  return {
    ok: true,
    plan: {
      changeId: null,
      files: [{ path: `sdlc/proposals/${id}.yaml`, content: stringifyYaml(next) }],
      events: [],
      commitMessage: `sdlc(${id}): accept — CLAUDE.md line in review on ${pr.number !== undefined ? `PR #${pr.number}` : pr.branch}`,
      trailers: { "SDLC-Actor": `human:${ctx.actor.id}` },
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

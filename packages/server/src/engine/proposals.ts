import { commitWritePlan, newUlid } from "@sdlc/adapter-git";
import { fileProposal, validateWritePlan, type Repo } from "@sdlc/core";
import { DEFAULT_AGENT_ID, readProposalDraft } from "@sdlc/mcp";
import type { StoredSession } from "../sessions/index.js";
import { SYSTEM_IDENTITY } from "./codehost.js";

export interface ProposalMirrorInput {
  root: string;
  /** The finished propose session; its draft sits beside its state in the worktree. */
  session: StoredSession;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export interface ProposalMirrorOutcome {
  /** Null when nothing was filed (no draft, or a proposal already answers the reason). */
  proposalId: string | null;
  commit: string | null;
  note: string;
}

/**
 * CLAUDE.md proposal mirror (FR-43, build-order 2.8): the line a propose
 * session drafted through `propose_claude_md_line` becomes
 * `sdlc/proposals/PRP-NNNN.yaml` (open) plus a note on the newest cited
 * change, committed by sdlc-bot on the default branch. Nothing here edits
 * CLAUDE.md; a human accepts the line into a PR or dismisses it.
 */
export async function mirrorProposal(input: ProposalMirrorInput, repo: Repo): Promise<ProposalMirrorOutcome> {
  const now = (input.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const { session } = input;
  const draft = readProposalDraft(session.worktreePath, session.id);
  if (!draft) return { proposalId: null, commit: null, note: `session ${session.id} ended without proposing a line` };
  const r = fileProposal(repo, { text: draft.text, citations: draft.citations, reason: draft.reason, agent: { id: input.env?.["SDLC_AGENT_ID"] ?? DEFAULT_AGENT_ID, session: session.id } }, { now, newId: newUlid });
  if (!r.ok) {
    const first = r.diagnostics[0];
    if (first?.rule === "proposal.exists") return { proposalId: null, commit: null, note: `not filed: ${first.message}` };
    throw new Error(r.diagnostics.map((d) => d.message).join("; "));
  }
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) throw new Error(`proposal rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
  const commit = await commitWritePlan(input.root, r.plan, { identity: SYSTEM_IDENTITY });
  return { proposalId: r.proposalId ?? null, commit, note: `${r.proposalId ?? "proposal"} filed for "${draft.reason}": ${draft.text}` };
}

import { commitWritePlan, headSha, newUlid } from "@sdlc/adapter-git";
import { findingsVerdict, recordReview, tallyFindings, validateWritePlan, type ChangeView, type Repo } from "@sdlc/core";
import type { Env } from "@sdlc/adapter-github";
import { DEFAULT_AGENT_ID, readFindings } from "@sdlc/mcp";
import type { StoredSession } from "../sessions/index.js";
import { SYSTEM_IDENTITY, codeHostFor, type CodeHost } from "./codehost.js";

export interface MirrorInput {
  root: string;
  view: ChangeView;
  /** The finished review session; its findings sit beside its rounds in the worktree's session state. */
  session: StoredSession;
  now?: () => Date;
  codeHost?: CodeHost;
  env?: Env;
}

export interface MirrorOutcome {
  commit: string;
  headSha: string;
  count: number;
  tally: { high: number; medium: number; low: number };
  verdict: "pass" | "fail";
}

/**
 * Review findings mirror (Stage 05, build-order 2.3): the findings a review
 * session reported through `report_finding` become `review.finding` events
 * and the tally/check/reviewed-head on `pr.yaml`, committed by sdlc-bot on
 * the default branch; the code host then gets the tally as a check and the
 * findings verbatim. Nothing here approves or merges.
 */
export async function mirrorReview(input: MirrorInput, repo: Repo): Promise<MirrorOutcome> {
  const now = (input.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const { session, view } = input;
  const reviewed = await headSha(session.worktreePath, "HEAD");
  const findings = readFindings(session.worktreePath, session.id).map((f) => ({ severity: f.severity, title: f.title, ...(f.path ? { path: f.path } : {}), ...(f.detail ? { detail: f.detail } : {}) }));
  const r = recordReview(repo, view, { session: session.id, agentId: input.env?.["SDLC_AGENT_ID"] ?? DEFAULT_AGENT_ID, headSha: reviewed, findings }, { now, newId: newUlid });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("; "));
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) throw new Error(`review mirror rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
  const commit = await commitWritePlan(input.root, r.plan, { identity: SYSTEM_IDENTITY });
  const tally = tallyFindings(findings);
  const verdict = findingsVerdict(tally);
  const pr = repo.changes.get(view.id)?.pr;
  if (pr) {
    const host = input.codeHost ?? codeHostFor(repo.config.codeHost, input.env);
    await host.reportReview(input.root, pr, { headSha: reviewed, session: session.id, findings, tally, verdict });
  }
  return { commit, headSha: reviewed, count: findings.length, tally, verdict };
}

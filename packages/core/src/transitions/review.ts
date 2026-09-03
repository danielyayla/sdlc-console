import { stringifyYaml, type Pr, type Severity } from "@sdlc/schemas";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, SYSTEM_ACTOR, type TransitionContext } from "./context.js";

export interface ReportedFinding {
  severity: Severity;
  title: string;
  path?: string;
  detail?: string;
}

export interface ReviewOutcome {
  /** Session that reviewed; the finding events carry it as the agent actor. */
  session: string;
  agentId: string;
  /** Head the review looked at; must be the PR's tested head. */
  headSha: string;
  findings: readonly ReportedFinding[];
}

export interface ReviewTally {
  high: number;
  medium: number;
  low: number;
}

export function tallyFindings(findings: readonly { severity: Severity }[]): ReviewTally {
  const tally: ReviewTally = { high: 0, medium: 0, low: 0 };
  for (const f of findings) tally[f.severity] += 1;
  return tally;
}

/** The findings check fails while a high finding stands; findings inform, the code owner still decides. */
export function findingsVerdict(tally: ReviewTally): "pass" | "fail" {
  return tally.high > 0 ? "fail" : "pass";
}

/**
 * Mirror a finished review job into the change (Stage 05): one
 * `review.finding` event per finding with the agent as actor, the severity
 * tally, a `findings` check and the reviewed head on `pr.yaml`. Committed by
 * the system on the default branch so the PR head stays the tested head.
 */
export function recordReview(repo: Repo, view: ChangeView, outcome: ReviewOutcome, ctx: Pick<TransitionContext, "now" | "newId">): TransitionResult {
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (!files.pr) return refuse("review.no-pr", `${view.id} has no pr.yaml; a review needs a pull request`);
  if (files.pr.mergedAt !== undefined) return refuse("review.merged", `${view.id}'s PR is already merged`);
  if (files.pr.headSha !== outcome.headSha) return refuse("review.head-mismatch", `the review looked at ${outcome.headSha.slice(0, 7)} but the PR head is ${files.pr.headSha.slice(0, 7)}; run the per-change run again`);
  if (files.pr.review?.headSha === outcome.headSha) return refuse("review.recorded", `head ${outcome.headSha.slice(0, 7)} was already reviewed by session ${files.pr.review.session}`);

  const tally = tallyFindings(outcome.findings);
  const verdict = findingsVerdict(tally);
  const ev = new EventBuilder({ ...ctx, actor: { id: SYSTEM_ACTOR.id } } as TransitionContext, files, view.id);
  const cycle = files.change.cycle;
  const events = outcome.findings.map((f) => ev.agent("review.finding", cycle, { severity: f.severity, title: f.title, ...(f.path ? { path: f.path } : {}), ...(f.detail ? { detail: f.detail } : {}) }, { id: outcome.agentId, session: outcome.session }));
  const pr: Pr = {
    ...files.pr,
    findings: tally,
    checks: [...files.pr.checks.filter((c) => c.name !== "findings"), { name: "findings", verdict }],
    review: { session: outcome.session, headSha: outcome.headSha, at: ctx.now },
  };
  const first = events[0];
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path: `${files.dir}/pr.yaml`, content: stringifyYaml(pr) }],
    events: events.map((e) => ev.write(e)),
    commitMessage: `sdlc(${view.id}): review of ${outcome.headSha.slice(0, 7)} · ${outcome.findings.length} finding${outcome.findings.length === 1 ? "" : "s"} (${tally.high} high, ${tally.medium} medium, ${tally.low} low)`,
    trailers: { ...(first ? { "SDLC-Event": first.id } : {}), "SDLC-Actor": `system:${SYSTEM_ACTOR.id}` },
    actor: { type: "system", id: SYSTEM_ACTOR.id },
  };
  return { ok: true, plan };
}

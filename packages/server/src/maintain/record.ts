import { commitWritePlan, gitRaw, headSha, prNoun, pushBranch } from "@sdlc/adapter-git";
import { hostedCodeHostFrom } from "../engine/codehost.js";
import { recordDiagnosis, validateWritePlan, type DiagnosisRecord, type Repo } from "@sdlc/core";
import { DEFAULT_AGENT_ID, readDiagnosisDraft, readRunbookRuns } from "@sdlc/mcp";
import { SYSTEM_IDENTITY } from "../engine/codehost.js";
import type { StoredSession } from "../sessions/registry.js";

export interface BandRecordInput {
  root: string;
  session: StoredSession;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface BandRecordOutcome {
  commit: string | null;
  triageId: string;
  diagnosed: boolean;
  runbookIds: string[];
  proposal: DiagnosisRecord["proposal"];
  note: string;
}

/**
 * A finished diagnose/propose session (3.4): what it reported through
 * `report_diagnosis` goes onto its triage item, every `run_runbook` call
 * becomes a `sdlc/loop/runbooks/RBK-NNNN.json` record, and a propose
 * session's commits on `sdlc/maintain/<metric>` become a pull request in
 * GitHub mode (the branch is noted in local mode). sdlc-bot commits; the
 * actor recorded is the agent. Nothing here merges.
 */
export async function recordBandSession(input: BandRecordInput, repo: Repo): Promise<BandRecordOutcome> {
  const { session } = input;
  const band = session.band;
  if (!band) throw new Error(`${session.id} is not a band session`);
  const draft = readDiagnosisDraft(session.worktreePath, session.id);
  const runs = readRunbookRuns(session.worktreePath, session.id);
  const agent = input.env?.["SDLC_AGENT_ID"] ?? DEFAULT_AGENT_ID;
  let proposal: DiagnosisRecord["proposal"] = null;
  if (band.tier === 3) {
    // the PR route: commits the session made on its branch, beyond the default branch
    const base = repo.config.defaultBranch;
    const ahead = await gitRaw(input.root, ["rev-list", "--count", `${base}..${session.branch}`]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) {
      const head = await headSha(input.root, session.branch);
      proposal = { branch: session.branch, head };
      if (repo.config.codeHost !== "local") {
        const host = hostedCodeHostFrom(repo.config.codeHost, input.env ?? process.env);
        if (host) {
          try {
            await pushBranch(input.root, session.branch);
            const pull = (await host.findOpenPr(input.root, session.branch)) ?? (await host.openHostedPr(input.root, { head: session.branch, base, title: `sdlc(${band.triageId}): ${draft?.title ?? `${band.metric} breached ${band.tier}σ`}`, body: [`Proposed by the 3σ propose job for ${band.metric} (${band.triageId}, session ${session.id}).`, "", draft ? `${draft.problem}\n\nProposed outcome: ${draft.proposedOutcome}` : "The session committed without reporting a diagnosis; see the triage item.", "", "The code owner decides by merging; the job never merges."].join("\n") }));
            proposal = { ...proposal, pr: { number: pull.number, url: pull.url } };
          } catch (e) {
            input.log?.(`${band.triageId}: branch ${session.branch} carries the proposal but the pull request was not opened: ${(e as Error).message}`);
          }
        } else input.log?.(`${band.triageId}: config.codeHost is ${repo.config.codeHost} but no token is set; ${session.branch} carries the proposal — push it and open the ${prNoun(repo.config.codeHost)} by hand`);
      }
    }
  }
  const record: DiagnosisRecord = {
    triageId: band.triageId,
    session: session.id,
    agent,
    diagnosis: draft ? { title: draft.title, problem: draft.problem, proposedOutcome: draft.proposedOutcome, affected: draft.affected, ...(draft.constraints ? { constraints: draft.constraints } : {}), ...(draft.openQuestions ? { openQuestions: draft.openQuestions } : {}) } : null,
    runbookRuns: runs.map((r) => ({ runbook: r.runbook, command: r.command, metric: r.metric, session: session.id, actor: { type: "agent", id: agent }, startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode, output: r.output })),
    proposal,
    outcome: `session ${session.status}${session.error ? `: ${session.error}` : ""}${session.costUsd !== null ? ` · $${session.costUsd}` : ""}`,
  };
  const r = recordDiagnosis(repo, record);
  if (!r.ok) {
    const first = r.diagnostics[0];
    if (first?.rule === "diagnosis.empty") return { commit: null, triageId: band.triageId, diagnosed: false, runbookIds: [], proposal, note: `${band.triageId}: ${first.message}` };
    throw new Error(r.diagnostics.map((d) => d.message).join("; "));
  }
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) throw new Error(`diagnosis rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
  const commit = await commitWritePlan(input.root, r.plan, { identity: SYSTEM_IDENTITY });
  const runbookIds = r.runbookIds ?? [];
  return { commit, triageId: band.triageId, diagnosed: draft !== null, runbookIds, proposal, note: `${band.triageId}: ${draft ? `diagnosis "${draft.title}"` : "no diagnosis"}${runbookIds.length > 0 ? ` · runbooks ${runbookIds.join(", ")}` : ""}${proposal?.pr ? ` · PR #${proposal.pr.number}` : proposal ? ` · branch ${proposal.branch}` : ""}` };
}

import { CodeHostError, git, mergeRemoteBranch, pushBranch, recordOpenedPr, recordSyncedPr, remoteUrl, type CodeHost, type GitIdentity, type OpenPrInput, type OpenPrResult, type ReviewReport } from "@sdlc/adapter-git";
import type { Pr } from "@sdlc/schemas";
import { GitHubClient, GitHubError } from "./client.js";
import { assertProtected } from "./protection.js";
import { getPull, mergePull, openPull, reviewPull } from "./pulls.js";
import { credentialsFrom, parseGitHubRemote, type Env, type GitHubCredentials, type GitHubRepo } from "./remote.js";
import { publishStatus, verdictState } from "./statuses.js";

export interface GitHubCodeHostOptions {
  credentials: GitHubCredentials;
  fetch?: typeof fetch;
  remote?: string;
}

function hostError(e: unknown): CodeHostError {
  if (e instanceof CodeHostError) return e;
  if (e instanceof GitHubError) return new CodeHostError(e.message, e.retryable, e.status);
  return new CodeHostError((e as Error).message, true);
}

/**
 * GitHub mode (token). The code PR is real: the task branch is pushed, the PR
 * opened, the evidence verdict published as a commit status, and gate 5
 * merges through the API — where branch protection, not this adapter, has
 * the last word.
 */
export class GitHubCodeHost implements CodeHost {
  readonly provider = "github" as const;
  readonly client: GitHubClient;
  private readonly remote: string;

  constructor(private readonly opts: GitHubCodeHostOptions) {
    this.client = new GitHubClient({ token: opts.credentials.token, apiUrl: opts.credentials.apiUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.remote = opts.remote ?? "origin";
  }

  async repoFor(root: string): Promise<GitHubRepo> {
    if (this.opts.credentials.repository) return this.opts.credentials.repository;
    const url = await remoteUrl(root, this.remote);
    const parsed = url ? parseGitHubRemote(url) : null;
    if (!parsed) throw new CodeHostError(`remote ${this.remote} is not a GitHub repository${url ? ` (${url})` : ""}; set GITHUB_REPOSITORY=owner/repo`, false);
    return parsed;
  }

  async openPr(input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const repo = await this.repoFor(input.root);
      await assertProtected(this.client, repo, input.baseBranch);
      await pushBranch(input.root, input.branch, this.remote);
      const verdict = input.checks.find((c) => c.name === "evidence")?.verdict ?? "pass";
      const pull = await openPull(this.client, repo, {
        head: input.branch,
        base: input.baseBranch,
        title: `sdlc(${input.view.id}): ${input.view.title}`,
        body: [`Change ${input.view.id} · cycle ${input.view.cycle} · risk ${input.view.risk}`, "", `Plan: sdlc/changes/${input.view.id}/plan.md`, `Evidence: sdlc/changes/${input.view.id}/evals/ (per-change run ${verdict === "pass" ? "green" : "red"})`, `Plan matches: ${input.planMatches === null ? "unknown" : input.planMatches ? "yes" : "no"}`].join("\n"),
      });
      if (pull.headSha !== input.headSha) throw new CodeHostError(`pushed ${input.branch} is at ${pull.headSha.slice(0, 7)} but the run tested ${input.headSha.slice(0, 7)}`, false);
      for (const check of input.checks) {
        await publishStatus(this.client, repo, input.headSha, { context: `sdlc/${check.name}`, state: verdictState(check.verdict), description: check.summary, targetUrl: pull.url });
      }
      const pr: Pr = {
        schema: 1,
        provider: "github",
        number: pull.number,
        url: pull.url,
        branch: input.branch,
        baseBranch: input.baseBranch,
        headSha: input.headSha,
        openedAt: input.now,
        reviewers: pull.reviewers,
        checks: input.checks.map((c) => ({ name: c.name, verdict: c.verdict, ...(c.summary ? { summary: c.summary } : {}) })),
      ...(input.autoFindings && input.autoFindings.length > 0 ? { autoFindings: input.autoFindings } : {}),
        planMatches: input.planMatches,
      };
      return await recordOpenedPr(input, pr);
    } catch (e) {
      throw hostError(e);
    }
  }

  /**
   * The PR's head moved (a push, delivered as `pull_request.synchronize`) and
   * the run tested it: the checks go on the new head as statuses and `pr.yaml`
   * follows. The PR must still be open at exactly the tested head.
   */
  async syncPr(input: OpenPrInput, existing: Pr): Promise<OpenPrResult> {
    if (existing.number === undefined) throw new CodeHostError("pr.yaml has no pull request number; nothing to synchronize on GitHub", false);
    try {
      const repo = await this.repoFor(input.root);
      await pushBranch(input.root, input.branch, this.remote);
      const pull = await getPull(this.client, repo, existing.number);
      if (pull.state !== "open" || pull.merged) throw new CodeHostError(`PR #${existing.number} is ${pull.merged ? "merged" : "closed"}; the head cannot be synchronized`, false);
      if (pull.headSha !== input.headSha) throw new CodeHostError(`PR #${existing.number} is at ${pull.headSha.slice(0, 7)} but the run tested ${input.headSha.slice(0, 7)}`, true);
      for (const check of input.checks) {
        await publishStatus(this.client, repo, input.headSha, { context: `sdlc/${check.name}`, state: verdictState(check.verdict), description: check.summary, targetUrl: pull.url });
      }
      return await recordSyncedPr(input, { ...existing, reviewers: pull.reviewers });
    } catch (e) {
      throw hostError(e);
    }
  }

  /**
   * Review outcome on the PR: the severity tally as the `sdlc/findings`
   * status on the reviewed head (failure while a high finding stands) and the
   * findings verbatim as a `COMMENT` review — never an approval.
   */
  async reportReview(root: string, pr: Pr, report: ReviewReport): Promise<void> {
    if (pr.number === undefined) throw new CodeHostError("pr.yaml has no pull request number; nothing to report on GitHub", false);
    try {
      const repo = await this.repoFor(root);
      const tally = `${report.tally.high} high · ${report.tally.medium} medium · ${report.tally.low} low`;
      await publishStatus(this.client, repo, report.headSha, { context: "sdlc/findings", state: report.verdict === "pass" ? "success" : "failure", description: `review of ${report.headSha.slice(0, 7)}: ${tally}`, ...(pr.url !== undefined ? { targetUrl: pr.url } : {}) });
      const lines = report.findings.map((f) => `- **${f.severity}** ${f.title}${f.path ? ` — \`${f.path}\`` : ""}${f.detail ? `\n\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""}`);
      const body = [`sdlc review of ${report.headSha.slice(0, 7)} (session ${report.session}): ${tally}.`, "", ...(lines.length > 0 ? lines : ["No findings."]), "", "Findings inform; a code owner approves and merges."].join("\n");
      await reviewPull(this.client, repo, pr.number, { event: "COMMENT", body });
    } catch (e) {
      throw hostError(e);
    }
  }

  async merge(root: string, pr: Pr, message: string, who: GitIdentity): Promise<string> {
    if (pr.number === undefined) throw new CodeHostError("pr.yaml has no pull request number; nothing to merge on GitHub", false);
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== pr.baseBranch) throw new CodeHostError(`merge into ${pr.baseBranch} needs it checked out (currently ${current})`, false);
    try {
      const repo = await this.repoFor(root);
      await assertProtected(this.client, repo, pr.baseBranch);
      const merged = await mergePull(this.client, repo, pr.number, { sha: pr.headSha, method: "merge", title: message });
      if (!merged.merged) throw new CodeHostError(`GitHub did not merge #${pr.number}: ${merged.message}`, true);
      await mergeRemoteBranch(root, pr.baseBranch, `${message.replace(/\s*\(gate 5\)$/, "")} — sync ${this.remote}/${pr.baseBranch} after #${pr.number}`, who, this.remote);
      return merged.sha;
    } catch (e) {
      throw hostError(e);
    }
  }
}

/** A GitHub host from the environment, or null when no token is set. */
export function gitHubCodeHostFrom(env: Env, fetchImpl?: typeof fetch): GitHubCodeHost | null {
  const credentials = credentialsFrom(env);
  if (!credentials) return null;
  return new GitHubCodeHost({ credentials, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

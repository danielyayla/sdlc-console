import { CodeHostError, git, mergeRemoteBranch, pushBranch, recordOpenedPr, recordSyncedPr, remoteUrl, type GitIdentity, type HostRepo, type HostedCodeHost, type HostedPr, type MergeHostedPrInput, type MergeOutcome, type OpenHostedPrInput, type OpenPrInput, type OpenPrResult, type PrCheck, type ReviewReport } from "@sdlc/adapter-git";
import type { Pr } from "@sdlc/schemas";
import { GitLabClient, GitLabError } from "./client.js";
import { findOpenMergeRequest, getMergeRequest, mergeMergeRequest, noteOnMergeRequest, openMergeRequest } from "./merge-requests.js";
import { assertProtected } from "./protection.js";
import { credentialsFrom, parseGitLabRemote, parseProjectPath, projectPathOf, projectRef, type Env, type GitLabCredentials, type ProjectRef } from "./remote.js";
import { publishStatus, verdictState } from "./statuses.js";

export interface GitLabCodeHostOptions {
  credentials: GitLabCredentials;
  fetch?: typeof fetch;
  remote?: string;
}

function hostError(e: unknown): CodeHostError {
  if (e instanceof CodeHostError) return e;
  if (e instanceof GitLabError) return new CodeHostError(e.message, e.retryable, e.status);
  return new CodeHostError((e as Error).message, true);
}

/** The findings status the review completes. */
const FINDINGS_CHECK = "sdlc/findings";

/**
 * GitLab mode (3.7) behind the same `CodeHost` contract as GitHub mode: the
 * task branch is pushed, a merge request opened, the checks published as
 * commit statuses (GitLab has no check-runs API; the statuses appear as
 * external jobs in the MR's pipeline widget), and gate 5 merges through the
 * API as the acting human — where the protected branch, not this adapter,
 * has the last word. `pr.yaml` keeps `number` = the MR iid and `url` = its
 * web URL. Nothing here approves a merge request.
 */
export class GitLabCodeHost implements HostedCodeHost {
  readonly provider = "gitlab" as const;
  readonly loginField = "gitlab" as const;
  readonly client: GitLabClient;
  private readonly remote: string;
  private resolved: { repo: HostRepo; ref: ProjectRef } | null = null;

  constructor(private readonly opts: GitLabCodeHostOptions) {
    const c = opts.credentials;
    this.client = new GitLabClient({ token: c.token, tokenKind: c.tokenKind, apiUrl: c.apiUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.remote = opts.remote ?? "origin";
  }

  label(number: number): string {
    return `MR !${number}`;
  }

  /** GitLab's no-reply form for a user is `<id>-<username>@users.noreply.gitlab.com`; without the id the username alone still names the account, never a real mailbox. */
  noreplyAddress(login: string): string {
    return `${login}@users.noreply.gitlab.com`;
  }

  /**
   * The project: `CI_PROJECT_PATH` as given, `CI_PROJECT_ID` resolved to its
   * path through the API (once), else the `origin` remote parsed.
   */
  private async resolve(root: string): Promise<{ repo: HostRepo; ref: ProjectRef }> {
    if (this.resolved) return this.resolved;
    const given = this.opts.credentials.project;
    if (given && /^\d+$/.test(given)) {
      const r = await this.client.get<{ path_with_namespace: string }>(`/projects/${given}`);
      const repo = parseProjectPath(r.data.path_with_namespace);
      if (!repo) throw new CodeHostError(`project ${given} reports an unusable path ${r.data.path_with_namespace}`, false);
      this.resolved = { repo, ref: given };
      return this.resolved;
    }
    if (given) {
      const repo = parseProjectPath(given);
      if (!repo) throw new CodeHostError(`CI_PROJECT_PATH=${given} is not a namespace/project path`, false);
      this.resolved = { repo, ref: projectRef(given) };
      return this.resolved;
    }
    const url = await remoteUrl(root, this.remote);
    const parsed = url ? parseGitLabRemote(url) : null;
    if (!parsed) throw new CodeHostError(`remote ${this.remote} is not a GitLab project${url ? ` (${url})` : ""}; set CI_PROJECT_PATH=namespace/project or CI_PROJECT_ID`, false);
    this.resolved = { repo: parsed, ref: projectRef(projectPathOf(parsed)) };
    return this.resolved;
  }

  async repoFor(root: string): Promise<HostRepo> {
    try {
      return (await this.resolve(root)).repo;
    } catch (e) {
      throw hostError(e);
    }
  }

  /** The `/projects/:id` segment for this clone's project. */
  async projectRef(root: string): Promise<ProjectRef> {
    try {
      return (await this.resolve(root)).ref;
    } catch (e) {
      throw hostError(e);
    }
  }

  async assertProtected(root: string, branch: string): Promise<void> {
    try {
      await assertProtected(this.client, await this.projectRef(root), branch);
    } catch (e) {
      throw hostError(e);
    }
  }

  async findOpenPr(root: string, headBranch: string): Promise<HostedPr | null> {
    try {
      return await findOpenMergeRequest(this.client, await this.projectRef(root), headBranch);
    } catch (e) {
      throw hostError(e);
    }
  }

  async openHostedPr(root: string, input: OpenHostedPrInput): Promise<HostedPr> {
    try {
      return await openMergeRequest(this.client, await this.projectRef(root), { sourceBranch: input.head, targetBranch: input.base, title: input.title, ...(input.body !== undefined ? { description: input.body } : {}), ...(input.draft !== undefined ? { draft: input.draft } : {}) });
    } catch (e) {
      throw hostError(e);
    }
  }

  async getHostedPr(root: string, number: number): Promise<HostedPr> {
    try {
      return await getMergeRequest(this.client, await this.projectRef(root), number);
    } catch (e) {
      throw hostError(e);
    }
  }

  async mergeHostedPr(root: string, number: number, input: MergeHostedPrInput): Promise<MergeOutcome> {
    try {
      return await mergeMergeRequest(this.client, await this.projectRef(root), number, { sha: input.sha, ...(input.title || input.message ? { message: [input.title, input.message].filter(Boolean).join("\n\n") } : {}) });
    } catch (e) {
      throw hostError(e);
    }
  }

  /**
   * Send-back on GitLab: a note carrying the feedback. GitLab's "request
   * changes" is a reviewer-side state the acting token cannot set on behalf of
   * a reviewer it is not; the ledger's `gate.sent_back` is the decision either way.
   */
  async requestChanges(root: string, number: number, body: string): Promise<void> {
    try {
      await noteOnMergeRequest(this.client, await this.projectRef(root), number, `**Sent back** — ${body}`);
    } catch (e) {
      throw hostError(e);
    }
  }

  private async publishChecks(project: ProjectRef, sha: string, checks: PrCheck[], url: string): Promise<void> {
    for (const check of checks) await publishStatus(this.client, project, sha, { name: `sdlc/${check.name}`, state: verdictState(check.verdict), description: check.summary, targetUrl: url });
  }

  async openPr(input: OpenPrInput): Promise<OpenPrResult> {
    try {
      const project = await this.projectRef(input.root);
      await assertProtected(this.client, project, input.baseBranch);
      await pushBranch(input.root, input.branch, this.remote);
      const verdict = input.checks.find((c) => c.name === "evidence")?.verdict ?? "pass";
      const mr = await openMergeRequest(this.client, project, {
        sourceBranch: input.branch,
        targetBranch: input.baseBranch,
        title: `sdlc(${input.view.id}): ${input.view.title}`,
        description: [`Change ${input.view.id} · cycle ${input.view.cycle} · risk ${input.view.risk}`, "", `Plan: sdlc/changes/${input.view.id}/plan.md`, `Evidence: sdlc/changes/${input.view.id}/evals/ (per-change run ${verdict === "pass" ? "green" : "red"})`, `Plan matches: ${input.planMatches === null ? "unknown" : input.planMatches ? "yes" : "no"}`].join("\n"),
      });
      if (mr.headSha !== input.headSha) throw new CodeHostError(`pushed ${input.branch} is at ${mr.headSha.slice(0, 7)} but the run tested ${input.headSha.slice(0, 7)}`, false);
      await this.publishChecks(project, input.headSha, input.checks, mr.url);
      const pr: Pr = {
        schema: 1,
        provider: "gitlab",
        number: mr.number,
        url: mr.url,
        branch: input.branch,
        baseBranch: input.baseBranch,
        headSha: input.headSha,
        openedAt: input.now,
        reviewers: mr.reviewers,
        checks: input.checks.map((c) => ({ name: c.name, verdict: c.verdict, ...(c.summary ? { summary: c.summary } : {}) })),
        ...(input.autoFindings && input.autoFindings.length > 0 ? { autoFindings: input.autoFindings } : {}),
        planMatches: input.planMatches,
      };
      return await recordOpenedPr(input, pr);
    } catch (e) {
      throw hostError(e);
    }
  }

  async syncPr(input: OpenPrInput, existing: Pr): Promise<OpenPrResult> {
    if (existing.number === undefined) throw new CodeHostError("pr.yaml has no merge request iid; nothing to synchronize on GitLab", false);
    try {
      const project = await this.projectRef(input.root);
      await pushBranch(input.root, input.branch, this.remote);
      const mr = await getMergeRequest(this.client, project, existing.number);
      if (mr.state !== "open" || mr.merged) throw new CodeHostError(`MR !${existing.number} is ${mr.merged ? "merged" : "closed"}; the head cannot be synchronized`, false);
      if (mr.headSha !== input.headSha) throw new CodeHostError(`MR !${existing.number} is at ${mr.headSha.slice(0, 7)} but the run tested ${input.headSha.slice(0, 7)}`, true);
      await this.publishChecks(project, input.headSha, input.checks, mr.url);
      return await recordSyncedPr(input, { ...existing, reviewers: mr.reviewers });
    } catch (e) {
      throw hostError(e);
    }
  }

  /**
   * Review outcome on the merge request: the severity tally as the
   * `sdlc/findings` status on the reviewed head (failed while a high finding
   * stands) and the findings verbatim as a note — never an approval. Both
   * land on a merged MR too.
   */
  async reportReview(root: string, pr: Pr, report: ReviewReport): Promise<void> {
    if (pr.number === undefined) throw new CodeHostError("pr.yaml has no merge request iid; nothing to report on GitLab", false);
    try {
      const project = await this.projectRef(root);
      const tally = `${report.tally.high} high · ${report.tally.medium} medium · ${report.tally.low} low`;
      const lines = report.findings.map((f) => `- **${f.severity}** ${f.title}${f.path ? ` — \`${f.path}\`` : ""}${f.detail ? `\n\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""}`);
      const late = report.mergedAt !== undefined ? [`This merge request merged at ${report.mergedAt}, before the review ended; the findings are on record for the code owner.`, ""] : [];
      const body = [`sdlc review of ${report.headSha.slice(0, 7)} (session ${report.session}): ${tally}.`, "", ...late, ...(lines.length > 0 ? lines : ["No findings."]), "", "Findings inform; a code owner approves and merges."].join("\n");
      await publishStatus(this.client, project, report.headSha, { name: FINDINGS_CHECK, state: report.verdict === "pass" ? "success" : "failed", description: `review of ${report.headSha.slice(0, 7)}: ${tally}`, ...(pr.url !== undefined ? { targetUrl: pr.url } : {}) });
      await noteOnMergeRequest(this.client, project, pr.number, body);
    } catch (e) {
      throw hostError(e);
    }
  }

  /** One check on a commit (3.6): a commit status, shown in the pipeline widget of the MR that carries the commit. */
  async publishCheck(root: string, sha: string, check: PrCheck, detailsUrl?: string): Promise<void> {
    try {
      await publishStatus(this.client, await this.projectRef(root), sha, { name: `sdlc/${check.name}`, state: verdictState(check.verdict), description: check.summary, ...(detailsUrl !== undefined ? { targetUrl: detailsUrl } : {}) });
    } catch (e) {
      throw hostError(e);
    }
  }

  async merge(root: string, pr: Pr, message: string, who: GitIdentity): Promise<string> {
    if (pr.number === undefined) throw new CodeHostError("pr.yaml has no merge request iid; nothing to merge on GitLab", false);
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== pr.baseBranch) throw new CodeHostError(`merge into ${pr.baseBranch} needs it checked out (currently ${current})`, false);
    try {
      const project = await this.projectRef(root);
      await assertProtected(this.client, project, pr.baseBranch);
      const merged = await mergeMergeRequest(this.client, project, pr.number, { sha: pr.headSha, message });
      if (!merged.merged) throw new CodeHostError(`GitLab did not merge !${pr.number}: ${merged.message}`, true);
      await mergeRemoteBranch(root, pr.baseBranch, `${message.replace(/\s*\(gate 5\)$/, "")} — sync ${this.remote}/${pr.baseBranch} after !${pr.number}`, who, this.remote);
      return merged.sha;
    } catch (e) {
      throw hostError(e);
    }
  }
}

/** A GitLab host from the environment, or null when no token is set. */
export function gitLabCodeHostFrom(env: Env, fetchImpl?: typeof fetch): GitLabCodeHost | null {
  const credentials = credentialsFrom(env);
  if (!credentials) return null;
  return new GitLabCodeHost({ credentials, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

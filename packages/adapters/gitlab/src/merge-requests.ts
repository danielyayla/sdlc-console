import type { HostedPr, MergeOutcome } from "@sdlc/adapter-git";
import { GitLabError, type GitLabClient } from "./client.js";
import type { ProjectRef } from "./remote.js";

/** A merge request as the REST API returns it (the fields the console reads). */
interface RawMergeRequest {
  iid: number;
  web_url: string;
  /** opened | closed | merged | locked */
  state: string;
  /** Head of the source branch. */
  sha: string;
  merge_commit_sha?: string | null;
  source_branch: string;
  target_branch: string;
  reviewers?: { username: string }[];
  /** `merge_user` on current GitLab; `merged_by` on older versions (deprecated, still served). */
  merge_user?: { username: string } | null;
  merged_by?: { username: string } | null;
  draft?: boolean;
  work_in_progress?: boolean;
  /** mergeable | checking | unchecked | preparing | not_open | ci_must_pass | conflict | not_approved | … */
  detailed_merge_status?: string | null;
  /** Older versions: can_be_merged | cannot_be_merged | unchecked | checking. */
  merge_status?: string | null;
}

/** States under which GitLab is still computing mergeability: the merge answers 405 meanwhile. */
const COMPUTING = new Set(["checking", "unchecked", "preparing"]);

export function normaliseMergeRequest(raw: RawMergeRequest): HostedPr {
  const merged = raw.state === "merged";
  return {
    number: raw.iid,
    url: raw.web_url,
    state: raw.state === "opened" || raw.state === "locked" ? "open" : "closed",
    merged,
    mergeSha: merged ? (raw.merge_commit_sha ?? null) : null,
    headSha: raw.sha,
    headRef: raw.source_branch,
    baseRef: raw.target_branch,
    reviewers: (raw.reviewers ?? []).map((r) => r.username),
    mergedBy: raw.merge_user?.username ?? raw.merged_by?.username ?? null,
    draft: raw.draft ?? raw.work_in_progress ?? false,
    mergeableState: raw.detailed_merge_status ?? raw.merge_status ?? null,
  };
}

const base = (p: ProjectRef): string => `/projects/${p}/merge_requests`;

export interface OpenMergeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  draft?: boolean;
}

export async function openMergeRequest(client: GitLabClient, project: ProjectRef, input: OpenMergeRequestInput): Promise<HostedPr> {
  const r = await client.post<RawMergeRequest>(base(project), {
    source_branch: input.sourceBranch,
    target_branch: input.targetBranch,
    title: input.draft ? `Draft: ${input.title}` : input.title,
    description: input.description ?? "",
    // the branch is the record the console keeps; GitLab does not delete it on merge (parity with GitHub mode)
    remove_source_branch: false,
  });
  return normaliseMergeRequest(r.data);
}

export async function getMergeRequest(client: GitLabClient, project: ProjectRef, iid: number): Promise<HostedPr> {
  const r = await client.get<RawMergeRequest>(`${base(project)}/${iid}`);
  return normaliseMergeRequest(r.data);
}

/** The open merge request whose source is `sourceBranch`, or null. */
export async function findOpenMergeRequest(client: GitLabClient, project: ProjectRef, sourceBranch: string): Promise<HostedPr | null> {
  const r = await client.get<RawMergeRequest[]>(`${base(project)}?state=opened&source_branch=${encodeURIComponent(sourceBranch)}&per_page=10`);
  const hit = r.data.find((m) => m.source_branch === sourceBranch);
  return hit ? normaliseMergeRequest(hit) : null;
}

export interface MergeWait {
  attempts: number;
  delayMs: number;
}

export interface MergeMergeRequestInput {
  /** Source-branch head the merge is valid for; GitLab answers 409 when the branch moved. */
  sha: string;
  /** Merge commit message (GitLab composes one otherwise). */
  message?: string;
  /** Delete the source branch on merge (default false: the branch is the record). */
  removeSourceBranch?: boolean;
  /** How long to wait for GitLab's mergeability check (default 10 × 1.5 s). */
  wait?: MergeWait;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_WAIT: MergeWait = { attempts: 10, delayMs: 1_500 };

/** GitLab recomputes mergeability after every push (`detailed_merge_status: checking`) and answers 405 to a merge meanwhile; wait for a known state. */
export async function waitMergeable(client: GitLabClient, project: ProjectRef, iid: number, wait: MergeWait): Promise<HostedPr> {
  let mr = await getMergeRequest(client, project, iid);
  for (let n = 0; n < wait.attempts && !mr.merged && (mr.mergeableState === null || COMPUTING.has(mr.mergeableState)); n++) {
    await sleep(wait.delayMs);
    mr = await getMergeRequest(client, project, iid);
  }
  return mr;
}

/**
 * Merge through the API: protected-branch rules and merge checks decide
 * (405 when blocked or a required pipeline has not passed, 406 on conflicts),
 * the sha precondition guards the tested head (409 when the source moved).
 * A 405 met while mergeability is still being computed is retried within
 * the same wait, as the GitHub adapter does for `mergeable_state: unknown`.
 */
export async function mergeMergeRequest(client: GitLabClient, project: ProjectRef, iid: number, input: MergeMergeRequestInput): Promise<MergeOutcome> {
  const wait = input.wait ?? DEFAULT_WAIT;
  await waitMergeable(client, project, iid, wait);
  for (let n = 0; ; n++) {
    try {
      const r = await client.put<RawMergeRequest>(`${base(project)}/${iid}/merge`, {
        sha: input.sha,
        ...(input.message ? { merge_commit_message: input.message } : {}),
        should_remove_source_branch: input.removeSourceBranch ?? false,
      });
      const mr = normaliseMergeRequest(r.data);
      return { sha: mr.mergeSha ?? r.data.merge_commit_sha ?? "", merged: mr.merged, message: mr.merged ? "Merge request successfully merged" : `merge request is ${r.data.state}` };
    } catch (e) {
      if (!(e instanceof GitLabError) || e.status !== 405 || n >= wait.attempts) throw e;
      await sleep(wait.delayMs);
      const mr = await getMergeRequest(client, project, iid);
      if (mr.mergeableState !== null && !COMPUTING.has(mr.mergeableState)) throw e;
    }
  }
}

/** A note (comment) on the merge request. GitLab has no "approve" here by design: nothing the console runs approves. */
export async function noteOnMergeRequest(client: GitLabClient, project: ProjectRef, iid: number, body: string): Promise<void> {
  await client.post(`${base(project)}/${iid}/notes`, { body });
}

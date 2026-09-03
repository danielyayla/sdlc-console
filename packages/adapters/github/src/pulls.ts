import type { GitHubClient } from "./client.js";
import type { GitHubRepo } from "./remote.js";

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  reviewers: string[];
  draft: boolean;
  /** GitHub's `mergeable_state` (clean, blocked, dirty, unstable, …) when known. */
  mergeableState: string | null;
}

interface RawPull {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  requested_reviewers?: { login: string }[];
  draft?: boolean;
  mergeable_state?: string | null;
}

function normalise(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    url: raw.html_url,
    state: raw.state === "closed" ? "closed" : "open",
    merged: raw.merged ?? false,
    mergeSha: raw.merged ? (raw.merge_commit_sha ?? null) : null,
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    reviewers: (raw.requested_reviewers ?? []).map((r) => r.login),
    draft: raw.draft ?? false,
    mergeableState: raw.mergeable_state ?? null,
  };
}

const base = (r: GitHubRepo): string => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

export interface OpenPullInput {
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export async function openPull(client: GitHubClient, repo: GitHubRepo, input: OpenPullInput): Promise<PullRequest> {
  const r = await client.post<RawPull>(`${base(repo)}/pulls`, { title: input.title, head: input.head, base: input.base, body: input.body ?? "", draft: input.draft ?? false });
  return normalise(r.data);
}

export async function getPull(client: GitHubClient, repo: GitHubRepo, number: number): Promise<PullRequest> {
  const r = await client.get<RawPull>(`${base(repo)}/pulls/${number}`);
  return normalise(r.data);
}

export interface MergePullInput {
  /** Head sha the merge is valid for; GitHub answers 409 when the branch moved. */
  sha: string;
  method?: "merge" | "squash" | "rebase";
  title?: string;
  message?: string;
}

export interface MergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

/** Merge through the API: branch protection decides (405 when blocked), the sha precondition guards the tested head. */
export async function mergePull(client: GitHubClient, repo: GitHubRepo, number: number, input: MergePullInput): Promise<MergeResult> {
  const r = await client.put<MergeResult>(`${base(repo)}/pulls/${number}/merge`, {
    sha: input.sha,
    merge_method: input.method ?? "merge",
    ...(input.title ? { commit_title: input.title } : {}),
    ...(input.message ? { commit_message: input.message } : {}),
  });
  return r.data;
}

/** Send-back in GitHub mode: a "request changes" review carrying the feedback. */
export async function requestChanges(client: GitHubClient, repo: GitHubRepo, number: number, body: string): Promise<void> {
  await client.post(`${base(repo)}/pulls/${number}/reviews`, { event: "REQUEST_CHANGES", body });
}

export async function commentOnPull(client: GitHubClient, repo: GitHubRepo, number: number, body: string): Promise<void> {
  await client.post(`${base(repo)}/issues/${number}/comments`, { body });
}

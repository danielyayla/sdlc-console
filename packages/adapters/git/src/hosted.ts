import type { CodeHost, CodeHostProvider } from "./codehost.js";

/**
 * What the server needs from a real code host beyond the code PR itself
 * (2.2 artifact PRs as gates, 2.4 webhooks, 3.7 GitLab): the same contract
 * for pull requests and merge requests, so `packages/server` never speaks to
 * one host's API directly. Nothing here approves; a merge is the acting
 * human's decision and the host's branch protection has the last word.
 */

/** The repository the host addresses: `owner/repo` on GitHub, `namespace/…/project` on GitLab (`owner` = the namespace path). */
export interface HostRepo {
  owner: string;
  repo: string;
}

/** A pull request (GitHub) or merge request (GitLab) as the host reports it. */
export interface HostedPr {
  /** PR number on GitHub, MR iid on GitLab — the `number` recorded in `pr.yaml`. */
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  reviewers: string[];
  /** Login (GitHub) or username (GitLab) of whoever merged it, when the host reports one. */
  mergedBy: string | null;
  draft: boolean;
  /** The host's mergeability verdict when known (`mergeable_state` / `detailed_merge_status`), null while it computes. */
  mergeableState: string | null;
}

export interface OpenHostedPrInput {
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface MergeHostedPrInput {
  /** Head sha the merge is valid for; the host refuses (retryable) when the branch moved. */
  sha: string;
  title?: string;
  message?: string;
}

export interface MergeOutcome {
  sha: string;
  merged: boolean;
  message: string;
}

/** The identity field on `config.identities[]` that carries a host login: `github` or `gitlab`. */
export type HostLoginField = "github" | "gitlab";

/**
 * A `CodeHost` with the primitives the artifact-PR and merge-detection passes
 * use. `GitHubCodeHost` and `GitLabCodeHost` implement it; `LocalCodeHost`
 * does not (there is nothing to open, find or merge on a local repository).
 */
export interface HostedCodeHost extends CodeHost {
  readonly provider: Exclude<CodeHostProvider, "local">;
  /** Which `config.identities[]` field maps a merger's login to a console identity. */
  readonly loginField: HostLoginField;
  /** "PR #12" / "MR !12" — how the host itself refers to the request. */
  label(number: number): string;
  /** No-reply address the host gives an unmapped login, so an unmapped merger is recorded without inventing an identity. */
  noreplyAddress(login: string): string;
  /** The repository this clone's remote (or the environment) names on the host. */
  repoFor(root: string): Promise<HostRepo>;
  /** Refuse (non-retryable) unless `branch` is protected on the host — hosted mode only exists under branch protection. */
  assertProtected(root: string, branch: string): Promise<void>;
  /** The open request whose head is `headBranch`, or null. */
  findOpenPr(root: string, headBranch: string): Promise<HostedPr | null>;
  openHostedPr(root: string, input: OpenHostedPrInput): Promise<HostedPr>;
  getHostedPr(root: string, number: number): Promise<HostedPr>;
  /** Merge through the API as the acting human; protection decides, the sha precondition guards the tested head. */
  mergeHostedPr(root: string, number: number, input: MergeHostedPrInput): Promise<MergeOutcome>;
  /** Send-back feedback on the request: a "request changes" review on GitHub, a note on GitLab. Never an approval. */
  requestChanges(root: string, number: number, body: string): Promise<void>;
}

export function isHostedCodeHost(host: CodeHost): host is HostedCodeHost {
  return host.provider !== "local" && typeof (host as Partial<HostedCodeHost>).openHostedPr === "function";
}

/** How a provider names its requests in messages: "PR #7" on GitHub, "MR !7" on GitLab, "PR #7" locally (a local record). */
export function prLabel(provider: CodeHostProvider, number: number | undefined): string {
  if (number === undefined) return provider === "gitlab" ? "MR" : "PR";
  return provider === "gitlab" ? `MR !${number}` : `PR #${number}`;
}

/** "pull request" / "merge request". */
export function prNoun(provider: CodeHostProvider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** Human name of the host for messages. */
export function hostName(provider: CodeHostProvider): string {
  return provider === "gitlab" ? "GitLab" : provider === "github" ? "GitHub" : "local";
}

export function sameRepo(a: HostRepo | null, b: HostRepo | null): boolean {
  return a !== null && b !== null && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * A verified inbound delivery reduced to routing facts (blueprint §9.5, 2.4).
 * Both hosts' parsers produce this shape so the engine handles one union:
 * GitLab's Merge Request Hook becomes `pull_request`, its Pipeline Hook a
 * `status`, its Push Hook a `push`. Nothing in a payload is an instruction.
 */
export type WebhookEvent =
  | { kind: "ping"; repo: HostRepo | null; zen: string | null }
  | { kind: "pull_request"; action: string; repo: HostRepo | null; number: number; headRef: string; headSha: string; baseRef: string; merged: boolean; mergeSha: string | null; mergedBy: string | null; state: "open" | "closed" }
  | { kind: "pull_request_review"; action: string; repo: HostRepo | null; number: number; state: string; author: string | null; headSha: string | null }
  | { kind: "check_run"; action: string; repo: HostRepo | null; name: string; status: string; conclusion: string | null; headSha: string }
  | { kind: "status"; repo: HostRepo | null; sha: string; context: string; state: string }
  | { kind: "push"; repo: HostRepo | null; ref: string; before: string; after: string; deleted: boolean; forced: boolean }
  | { kind: "other"; event: string; action: string | null; repo: HostRepo | null };

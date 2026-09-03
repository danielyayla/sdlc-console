import type { GitHubClient } from "./client.js";
import type { GitHubRepo } from "./remote.js";

export type StatusState = "success" | "failure" | "pending" | "error";

export interface StatusInput {
  /** e.g. `sdlc/evidence`, `sdlc/findings`, `sdlc/evals` */
  context: string;
  state: StatusState;
  description?: string;
  targetUrl?: string;
}

/** Commit statuses are the token-mode form of `checks.publish`; check runs need a GitHub App. */
export async function publishStatus(client: GitHubClient, repo: GitHubRepo, sha: string, input: StatusInput): Promise<void> {
  const description = input.description === undefined ? undefined : input.description.length > 140 ? `${input.description.slice(0, 137)}…` : input.description;
  await client.post(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/statuses/${sha}`, {
    state: input.state,
    context: input.context,
    ...(description !== undefined ? { description } : {}),
    ...(input.targetUrl !== undefined ? { target_url: input.targetUrl } : {}),
  });
}

export function verdictState(verdict: "pass" | "fail" | "pending"): StatusState {
  return verdict === "pass" ? "success" : verdict === "fail" ? "failure" : "pending";
}

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

export interface CommitStatus {
  context: string;
  state: StatusState;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CombinedStatus {
  state: StatusState;
  statuses: CommitStatus[];
}

interface RawCombined {
  state: string;
  statuses?: { context: string; state: string; description?: string | null; created_at: string; updated_at: string }[];
}

const asState = (s: string): StatusState => (s === "success" || s === "failure" || s === "pending" || s === "error" ? s : "error");

/** The combined status of a commit: every context's latest state with its timing (metrics: CI verdicts and timing). */
export async function combinedStatus(client: GitHubClient, repo: GitHubRepo, sha: string): Promise<CombinedStatus> {
  const r = await client.get<RawCombined>(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${sha}/status`);
  return {
    state: asState(r.data.state),
    statuses: (r.data.statuses ?? []).map((s) => ({ context: s.context, state: asState(s.state), description: s.description ?? null, createdAt: s.created_at, updatedAt: s.updated_at })),
  };
}

import { GitLabError, type GitLabClient } from "./client.js";
import type { ProjectRef } from "./remote.js";

/** GitLab commit-status states (`POST /projects/:id/statuses/:sha`). */
export type GitLabStatusState = "pending" | "running" | "success" | "failed" | "canceled";

export interface StatusInput {
  /** The status name, shown in the MR pipeline widget: `sdlc/evidence`, `sdlc/evals`, `sdlc/repro`, `sdlc/findings`, `sdlc/rollback-rehearsed`. */
  name: string;
  state: GitLabStatusState;
  description?: string;
  targetUrl?: string;
}

/**
 * GitLab has no check-runs API: an external status on the commit is the
 * check, and GitLab shows it as an external job in the merge request's
 * pipeline widget (and in merge checks when "pipelines must succeed" is on).
 * Re-posting the same name with the same state is refused by GitLab as an
 * invalid transition (400 "Cannot transition status …"); that is the state
 * already being what we asked for, so it is treated as done.
 */
export async function publishStatus(client: GitLabClient, project: ProjectRef, sha: string, input: StatusInput): Promise<void> {
  const description = input.description === undefined ? undefined : input.description.length > 255 ? `${input.description.slice(0, 252)}…` : input.description;
  try {
    await client.post(`/projects/${project}/statuses/${sha}`, {
      state: input.state,
      name: input.name,
      ...(description !== undefined ? { description } : {}),
      ...(input.targetUrl !== undefined ? { target_url: input.targetUrl } : {}),
    });
  } catch (e) {
    if (e instanceof GitLabError && e.status === 400 && /transition/i.test(e.detail)) return;
    throw e;
  }
}

export function verdictState(verdict: "pass" | "fail" | "pending"): GitLabStatusState {
  return verdict === "pass" ? "success" : verdict === "fail" ? "failed" : "pending";
}

export interface CommitStatus {
  name: string;
  state: GitLabStatusState;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawStatus {
  name: string;
  status: string;
  description?: string | null;
  created_at: string;
  finished_at?: string | null;
}

const asState = (s: string): GitLabStatusState => (s === "success" || s === "failed" || s === "pending" || s === "running" || s === "canceled" ? s : "failed");

/** The statuses on a commit, latest per name (`GET /projects/:id/repository/commits/:sha/statuses`). */
export async function commitStatuses(client: GitLabClient, project: ProjectRef, sha: string): Promise<CommitStatus[]> {
  const r = await client.get<RawStatus[]>(`/projects/${project}/repository/commits/${sha}/statuses?per_page=100`);
  const latest = new Map<string, CommitStatus>();
  for (const s of r.data) latest.set(s.name, { name: s.name, state: asState(s.status), description: s.description ?? null, createdAt: s.created_at, updatedAt: s.finished_at ?? s.created_at });
  return [...latest.values()];
}

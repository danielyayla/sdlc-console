import type { GitHubClient } from "./client.js";
import type { GitHubRepo } from "./remote.js";

export type CheckStatus = "queued" | "in_progress" | "completed";
export type CheckConclusion = "success" | "failure" | "neutral" | "action_required";

export interface CheckRunInput {
  /** `sdlc/evidence`, `sdlc/evals`, `sdlc/repro`, `sdlc/findings` — the same names the token-mode statuses carry. */
  name: string;
  headSha: string;
  status: CheckStatus;
  conclusion?: CheckConclusion;
  title: string;
  summary: string;
  /** Evidence, verbatim: command output, findings. Clipped at GitHub's limit with a pointer to the committed file, never summarised. */
  text?: string;
  detailsUrl?: string;
}

export interface CheckRun {
  id: number;
  name: string;
  headSha: string;
  status: CheckStatus;
  conclusion: CheckConclusion | null;
  url: string | null;
}

interface RawCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
}

/** GitHub caps `output.text` and `output.summary` at 65535 characters. */
export const CHECK_TEXT_LIMIT = 65_535;

/** Never a summary: the head of the output verbatim plus a line saying how much is missing and where the whole of it is. */
export function clipEvidence(text: string, keep = CHECK_TEXT_LIMIT, where = "the committed run file"): string {
  if (text.length <= keep) return text;
  const note = `\n\n… ${text.length - keep} more characters — the full output is in ${where}`;
  return `${text.slice(0, keep - note.length)}${note}`;
}

const base = (r: GitHubRepo): string => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

const normalise = (raw: RawCheckRun): CheckRun => ({
  id: raw.id,
  name: raw.name,
  headSha: raw.head_sha,
  status: raw.status === "queued" || raw.status === "in_progress" ? raw.status : "completed",
  conclusion: raw.conclusion === "success" || raw.conclusion === "failure" || raw.conclusion === "neutral" || raw.conclusion === "action_required" ? raw.conclusion : null,
  url: raw.html_url ?? null,
});

function body(input: Omit<CheckRunInput, "headSha" | "name"> & Partial<Pick<CheckRunInput, "headSha" | "name">>): Record<string, unknown> {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.headSha !== undefined ? { head_sha: input.headSha } : {}),
    status: input.status,
    ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
    ...(input.detailsUrl !== undefined ? { details_url: input.detailsUrl } : {}),
    output: { title: input.title, summary: clipEvidence(input.summary), ...(input.text !== undefined ? { text: clipEvidence(input.text) } : {}) },
  };
}

/** Check runs need a GitHub App: `POST /repos/{o}/{r}/check-runs`. */
export async function createCheckRun(client: GitHubClient, repo: GitHubRepo, input: CheckRunInput): Promise<CheckRun> {
  const r = await client.post<RawCheckRun>(`${base(repo)}/check-runs`, body(input));
  return normalise(r.data);
}

export async function updateCheckRun(client: GitHubClient, repo: GitHubRepo, id: number, input: Omit<CheckRunInput, "headSha" | "name">): Promise<CheckRun> {
  const r = await client.patch<RawCheckRun>(`${base(repo)}/check-runs/${id}`, body(input));
  return normalise(r.data);
}

/** Check runs on a head (optionally one name), newest first as GitHub lists them. */
export async function listCheckRuns(client: GitHubClient, repo: GitHubRepo, sha: string, name?: string): Promise<CheckRun[]> {
  const q = name ? `?check_name=${encodeURIComponent(name)}&per_page=100` : "?per_page=100";
  const r = await client.get<{ check_runs?: RawCheckRun[] }>(`${base(repo)}/commits/${sha}/check-runs${q}`);
  return (r.data.check_runs ?? []).map(normalise);
}

/**
 * One run per `(head, name)`: a run that already exists on the head is
 * updated in place — so `sdlc/findings` created `in_progress` when the PR
 * opens completes with the review's tally, and a re-run of the same head
 * rewrites its evidence instead of stacking a second run.
 */
export async function publishCheckRun(client: GitHubClient, repo: GitHubRepo, input: CheckRunInput): Promise<CheckRun> {
  const existing = (await listCheckRuns(client, repo, input.headSha, input.name))[0];
  if (existing) {
    const { headSha: _h, name: _n, ...rest } = input;
    void _h;
    void _n;
    return updateCheckRun(client, repo, existing.id, rest);
  }
  return createCheckRun(client, repo, input);
}

export function checkConclusion(verdict: "pass" | "fail" | "pending"): { status: CheckStatus; conclusion?: CheckConclusion } {
  return verdict === "pass" ? { status: "completed", conclusion: "success" } : verdict === "fail" ? { status: "completed", conclusion: "failure" } : { status: "in_progress" };
}

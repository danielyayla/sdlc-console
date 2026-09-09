import type { HostRepo } from "@sdlc/adapter-git";
import type { GitLabTokenKind } from "./client.js";

/**
 * A GitLab project as the API addresses it: a numeric id or the URL-encoded
 * `namespace/…/project` path. Namespaces nest, so the `owner` half of the
 * `HostRepo` is the whole namespace path (`group/subgroup`).
 */
export type ProjectRef = string;

/** `group/sub/project` → `{ owner: "group/sub", repo: "project" }`; null unless at least namespace/project. */
export function parseProjectPath(path: string): HostRepo | null {
  const parts = path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((p) => p !== "");
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1] ?? "";
  return { owner: parts.slice(0, -1).join("/"), repo };
}

/**
 * Namespace and project from an `origin` URL: `https://gitlab.com/g/s/p(.git)`,
 * `git@gitlab.com:g/s/p.git`, `ssh://git@gitlab.example.com:2222/g/p.git`.
 * Any host is accepted so self-managed instances work with `CI_API_V4_URL`.
 */
export function parseGitLabRemote(url: string): HostRepo | null {
  const trimmed = url.trim();
  const m = /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@\s]+@[^:/\s]+:)(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!m?.[1]) return null;
  return parseProjectPath(m[1]);
}

/** The path segment for `/projects/:id`: a numeric id as-is, a path URL-encoded (`group%2Fproject`). */
export function projectRef(project: string): ProjectRef {
  return /^\d+$/.test(project) ? project : encodeURIComponent(project.replace(/^\/+|\/+$/g, ""));
}

export function projectPathOf(repo: HostRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

export interface GitLabCredentials {
  token: string;
  tokenKind: GitLabTokenKind;
  apiUrl: string;
  /** `CI_PROJECT_ID` (numeric) or `CI_PROJECT_PATH` (`namespace/project`); null → parse the origin remote. */
  project: string | null;
}

export type Env = Record<string, string | undefined>;

/**
 * `GITLAB_TOKEN` (a personal, project or group access token with `api`
 * scope), else `CI_JOB_TOKEN` as a last resort — GitLab lets a job token
 * read its own project but not open or merge merge requests nor publish
 * commit statuses, so a pipeline needs a real token in `GITLAB_TOKEN`;
 * `CI_API_V4_URL`; `CI_PROJECT_ID` or `CI_PROJECT_PATH` — the names GitLab
 * CI sets. Null without a token.
 */
export function credentialsFrom(env: Env): GitLabCredentials | null {
  const personal = env["GITLAB_TOKEN"]?.trim();
  const job = env["CI_JOB_TOKEN"]?.trim();
  if (!personal && !job) return null;
  const project = env["CI_PROJECT_ID"]?.trim() || env["CI_PROJECT_PATH"]?.trim() || null;
  return {
    token: personal || job || "",
    tokenKind: personal ? "private" : "job",
    apiUrl: env["CI_API_V4_URL"]?.trim() || "https://gitlab.com/api/v4",
    project,
  };
}

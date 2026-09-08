import { appCredentialsFrom, type GitHubAppCredentials } from "./app.js";

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Owner and repository from an `origin` URL: `https://github.com/o/r(.git)`,
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`. Any host is
 * accepted so enterprise remotes work with `GITHUB_API_URL`.
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const trimmed = url.trim();
  const m = /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@\s]+@[^:]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

export function parseRepoSlug(slug: string): GitHubRepo | null {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(slug.trim());
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

export interface GitHubCredentials {
  /** Token mode (`GITHUB_TOKEN` / `GH_TOKEN`); null under the App. */
  token: string | null;
  /** App mode (3.2): `SDLC_GITHUB_APP_*`; takes precedence over a token when both are set. */
  app: GitHubAppCredentials | null;
  apiUrl: string;
  /** `GITHUB_REPOSITORY=owner/repo` overrides the origin remote. */
  repository: GitHubRepo | null;
}

export type Env = Record<string, string | undefined>;

/**
 * `GITHUB_TOKEN` (or `GH_TOKEN`), `GITHUB_API_URL`, `GITHUB_REPOSITORY` — the
 * same names GitHub Actions uses — or the App variables (`SDLC_GITHUB_APP_ID`,
 * `SDLC_GITHUB_APP_INSTALLATION_ID`, `SDLC_GITHUB_APP_PRIVATE_KEY[_FILE]`).
 * Null with neither; token mode is the default when no App variable is set.
 */
export function credentialsFrom(env: Env): GitHubCredentials | null {
  const app = appCredentialsFrom(env);
  const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? null;
  if (!app && !token) return null;
  const slug = env["GITHUB_REPOSITORY"];
  return { token: app ? null : token, app, apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com", repository: slug ? parseRepoSlug(slug) : null };
}

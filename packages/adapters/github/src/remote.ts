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
  token: string;
  apiUrl: string;
  /** `GITHUB_REPOSITORY=owner/repo` overrides the origin remote. */
  repository: GitHubRepo | null;
}

export type Env = Record<string, string | undefined>;

/** `GITHUB_TOKEN` (or `GH_TOKEN`), `GITHUB_API_URL`, `GITHUB_REPOSITORY` — the same names GitHub Actions uses. Null without a token. */
export function credentialsFrom(env: Env): GitHubCredentials | null {
  const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
  if (!token) return null;
  const slug = env["GITHUB_REPOSITORY"];
  return { token, apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com", repository: slug ? parseRepoSlug(slug) : null };
}

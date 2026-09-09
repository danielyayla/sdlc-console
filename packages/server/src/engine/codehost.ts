import { CodeHostError, LocalCodeHost, SYSTEM_IDENTITY, systemEvent, type CodeHost, type CodeHostProvider, type HostedCodeHost } from "@sdlc/adapter-git";
import { gitHubCodeHostFrom, type Env } from "@sdlc/adapter-github";
import { gitLabCodeHostFrom } from "@sdlc/adapter-gitlab";

export { SYSTEM_IDENTITY, systemEvent, LocalCodeHost, CodeHostError };
export type { CodeHost, HostedCodeHost };

/** What each hosted provider needs in the environment of `sdlc serve` / `sdlc accept`. */
export const HOST_CREDENTIALS_HINT: Record<"github" | "gitlab", string> = {
  github: "GitHub mode needs GITHUB_TOKEN (or GH_TOKEN), or a GitHub App (SDLC_GITHUB_APP_ID, SDLC_GITHUB_APP_INSTALLATION_ID, SDLC_GITHUB_APP_PRIVATE_KEY[_FILE]), in the environment of sdlc serve / sdlc accept; set config.codeHost: local to work without a code host",
  gitlab: "GitLab mode needs GITLAB_TOKEN (an access token with api scope — a CI_JOB_TOKEN cannot open or merge merge requests) and CI_API_V4_URL for a self-managed instance, in the environment of sdlc serve / sdlc accept; set config.codeHost: local to work without a code host",
};

/**
 * The hosted code host for `config.codeHost` (GitHub or GitLab) from the
 * environment, or null in local mode or without credentials. The caller
 * decides what a missing host means (the engine logs and skips; an action
 * refuses).
 */
export function hostedCodeHostFrom(provider: CodeHostProvider, env: Env = process.env): HostedCodeHost | null {
  if (provider === "github") return gitHubCodeHostFrom(env);
  if (provider === "gitlab") return gitLabCodeHostFrom(env);
  return null;
}

/** The hosted code host, or a clear non-retryable refusal: hosted mode without credentials never falls back to a local merge (that would be a way around branch protection). */
export function hostedCodeHostFor(provider: CodeHostProvider, env: Env = process.env): HostedCodeHost {
  if (provider === "local") throw new CodeHostError("config.codeHost is local: there is no code host to open or merge requests on", false);
  const host = hostedCodeHostFrom(provider, env);
  if (!host) throw new CodeHostError(HOST_CREDENTIALS_HINT[provider], false);
  return host;
}

/** The code host for `config.codeHost`: local, or the hosted one (refusing clearly without credentials). */
export function codeHostFor(provider: CodeHostProvider, env: Env = process.env): CodeHost {
  if (provider === "local") return new LocalCodeHost();
  return hostedCodeHostFor(provider, env);
}

import { CodeHostError, LocalCodeHost, SYSTEM_IDENTITY, systemEvent, type CodeHost } from "@sdlc/adapter-git";
import { gitHubCodeHostFrom, type Env } from "@sdlc/adapter-github";

export { SYSTEM_IDENTITY, systemEvent, LocalCodeHost, CodeHostError };
export type { CodeHost };

/**
 * The code host for `config.codeHost`. GitHub mode needs `GITHUB_TOKEN` in the
 * server's environment; without it the host refuses clearly instead of
 * falling back to a local merge (that would be a way around branch protection).
 */
export function codeHostFor(provider: "local" | "github", env: Env = process.env): CodeHost {
  if (provider === "local") return new LocalCodeHost();
  const host = gitHubCodeHostFrom(env);
  if (!host) throw new CodeHostError("GitHub mode needs GITHUB_TOKEN (or GH_TOKEN) in the environment of sdlc serve / sdlc accept; set config.codeHost: local to work without a code host", false);
  return host;
}

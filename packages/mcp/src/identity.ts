import type { GitIdentity } from "@sdlc/adapter-git";

export const DEFAULT_AGENT_ID = "claude-code@sdlc.local";

/** Commits made by the MCP server carry the agent identity, never the engineer's (§8.9 point 5). */
export function agentIdentity(env: Record<string, string | undefined>): GitIdentity {
  return { id: env["SDLC_AGENT_ID"] ?? DEFAULT_AGENT_ID, name: env["SDLC_AGENT_NAME"] ?? "claude-code" };
}

/** Session id for events: explicit tool argument, else the launcher's `SDLC_SESSION`, else a stable default. */
export function sessionIdFrom(env: Record<string, string | undefined>, explicit?: string): string {
  return explicit && explicit.trim() !== "" ? explicit : (env["SDLC_SESSION"] ?? "mcp-session");
}

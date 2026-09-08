import { agentDeployableEnvironments, type ResolvedConfig } from "@sdlc/core";

/** `deploy_<env>`: the tool name for an agent-deployable environment (a slug; dashes become underscores). */
export function deployToolName(envName: string): string {
  return `deploy_${envName.replace(/-/g, "_")}`;
}

export const REHEARSE_TOOL = "rehearse_rollback";

/** The environment tools a configuration yields (3.6): one `deploy_<env>` per non-production environment plus `rehearse_rollback` when there is one; nothing for production. */
export function deployToolNames(config: ResolvedConfig): string[] {
  const envs = agentDeployableEnvironments(config);
  return envs.length === 0 ? [] : [...envs.map((e) => deployToolName(e.name)), REHEARSE_TOOL];
}


import type { Repo } from "@sdlc/core";
import type { HookContext } from "./context.js";
import { toolCommand, type HookInput } from "./input.js";
import { appendHookEvent } from "./ledger.js";
import type { HookResult } from "./run.js";

/** The environments a command would touch: a declared production deploy or rollback command, or `sdlc deploy <production env>`. */
export function productionCommandMatch(command: string, repo: Repo): { env: string; what: "deploy" | "rollback" | "cli" } | null {
  const text = command.trim();
  for (const env of repo.config.environments) {
    if (env.kind !== "production") continue;
    if (text.includes(env.deployCommand)) return { env: env.name, what: "deploy" };
    if (text.includes(env.rollbackCommand)) return { env: env.name, what: "rollback" };
    if (new RegExp(`\\bsdlc\\s+(deploy|rehearse-rollback)\\s+${env.name}\\b`).test(text)) return { env: env.name, what: "cli" };
  }
  return null;
}

/**
 * production-gate (pre-deploy, block; FR-40, 3.6): an agent's shell command
 * that would deploy or roll back a production environment is blocked — the
 * production deploy is a person's gate decision (`sdlc deploy <env> <CHG>` or
 * the console) after a rehearsed rollback, and no hook input can supply it.
 * Every block is logged on the change ledger when the session has one.
 */
export function productionGate(input: HookInput, ctx: HookContext | null, repo: Repo | null, now: Date): HookResult {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return { allowed: true, reason: "not a shell command", logged: false };
  const command = toolCommand(input);
  if (!command) return { allowed: true, reason: "no command", logged: false };
  if (!repo) return { allowed: true, reason: "no repository context — production-gate not enforced here", logged: false };
  const production = repo.config.environments.filter((e) => e.kind === "production");
  if (production.length === 0) return { allowed: true, reason: "no production environment declared in sdlc/config.yaml", logged: false };
  const hit = productionCommandMatch(command, repo);
  if (!hit) return { allowed: true, reason: "not a production command", logged: false };
  const env = production.find((e) => e.name === hit.env);
  const roles = env?.gateRoles.join(" or ") ?? "the gate role";
  const reason = `production-gate: ${hit.env} is deployed only through the production gate — a person holding ${roles} runs \`sdlc deploy ${hit.env} <CHG>\` (or the console's Deploy) once a rollback rehearsal at the merged commit is on record; an agent has no path into production. Deploy to a non-production environment with the deploy_<env> tool and rehearse the rollback there with rehearse_rollback.`;
  if (ctx) {
    appendHookEvent(ctx.root, ctx.changeId, ctx.view.cycle, input.session_id, "hook.blocked", { hook: "production-gate", reason: `${hit.what} command for ${hit.env} refused: production deploys go through the gate` }, now);
    return { allowed: false, reason, logged: true };
  }
  return { allowed: false, reason, logged: false };
}

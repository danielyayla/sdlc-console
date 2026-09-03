import { relative } from "node:path";
import { git, stagedFiles } from "@sdlc/adapter-git";
import { check } from "@sdlc/core";
import type { HookContext } from "./context.js";
import { toolCommand, type HookInput } from "./input.js";
import { appendHookEvent } from "./ledger.js";
import type { HookResult } from "./run.js";

const COMMIT = /\bgit\b[^|;&]*\bcommit\b/;

/** plan-sync (commit, block): files in the commit ⊆ plan.md "Files that change", or plan.md in the same commit (FR-41). */
export async function planSync(input: HookInput, ctx: HookContext | null, now: Date): Promise<HookResult> {
  const command = toolCommand(input);
  if (input.tool_name !== "Bash" || !command || !COMMIT.test(command)) return { allowed: true, reason: "not a commit", logged: false };
  if (!ctx) return { allowed: true, reason: "no change context — plan-sync not enforced here", logged: false };
  let files = await stagedFiles(ctx.root);
  if (/\s-(a|-all)\b/.test(command) || /\s-am\b/.test(command)) {
    const tracked = (await git(ctx.root, ["diff", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean);
    files = [...new Set([...files, ...tracked])];
  }
  const cwdRel = relative(ctx.root, input.cwd);
  void cwdRel;
  const planPath = `${ctx.files.dir}/plan.md`;
  const result = check.planSync(files, ctx.view.planFiles, planPath);
  if (result.allowed) {
    appendHookEvent(ctx.root, ctx.changeId, ctx.view.cycle, input.session_id, "hook.allowed", { hook: "plan-sync" }, now);
    return { allowed: true, reason: result.reason, logged: true };
  }
  appendHookEvent(ctx.root, ctx.changeId, ctx.view.cycle, input.session_id, "hook.blocked", { hook: "plan-sync", reason: result.reason, ...(result.offending[0] ? { path: result.offending[0] } : {}) }, now);
  return { allowed: false, reason: `plan-sync blocked the commit: ${result.reason}`, logged: true };
}

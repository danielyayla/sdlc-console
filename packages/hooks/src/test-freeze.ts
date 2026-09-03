import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { check } from "@sdlc/core";
import type { HookContext } from "./context.js";
import { toolFilePath, type HookInput } from "./input.js";
import { appendHookEvent } from "./ledger.js";
import type { HookResult } from "./run.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** realpath of the nearest existing ancestor, with the missing tail re-appended. */
function realpathLenient(p: string): string {
  let head = p;
  let tail = "";
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p;
    tail = join(head.slice(parent.length), tail);
    head = parent;
  }
  try {
    return join(realpathSync(head), tail);
  } catch {
    return p;
  }
}

/** Path relative to the worktree root, robust to symlinked temp dirs (/var → /private/var on macOS) and files not yet created. */
export function relToRoot(root: string, cwd: string, raw: string): string {
  const abs = isAbsolute(raw) ? raw : join(cwd, raw);
  const candidates = [abs, realpathLenient(abs)];
  const roots = [root, realpathLenient(root)];
  for (const r of roots) for (const c of candidates) {
    const rel = relative(r, c).split("\\").join("/");
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return relative(root, abs).split("\\").join("/");
}

/** test-freeze (edit, block): no edits under the test globs while a repro test is committed (FR-40/FR-51). */
export function testFreeze(input: HookInput, ctx: HookContext | null, now: Date): HookResult {
  if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return { allowed: true, reason: "not an edit", logged: false };
  const raw = toolFilePath(input);
  if (!raw) return { allowed: true, reason: "no file path", logged: false };
  if (!ctx) return { allowed: true, reason: "no change context — test-freeze not enforced here", logged: false };
  const path = relToRoot(ctx.root, input.cwd, raw);
  const globs = ctx.repo.verification?.testGlobs ?? [];
  const result = check.testFreeze(path, ctx.view, ctx.files, globs);
  if (result.allowed) return { allowed: true, reason: result.reason, logged: false };
  appendHookEvent(ctx.root, ctx.changeId, ctx.view.cycle, input.session_id, "hook.blocked", { hook: "test-freeze", reason: "test freeze active", path }, now);
  return { allowed: false, reason: `test-freeze blocked edit to ${path} — ${result.reason}`, logged: true };
}

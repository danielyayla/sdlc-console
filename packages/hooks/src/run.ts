import { hookContext } from "./context.js";
import type { HookInput } from "./input.js";
import { planSync } from "./plan-sync.js";
import { testFreeze } from "./test-freeze.js";
import { verifyBeforeDone, type RunOptions } from "./verify-before-done.js";

export const HOOK_NAMES = ["plan-sync", "test-freeze", "verify-before-done"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export interface HookResult {
  allowed: boolean;
  reason: string;
  /** Whether a ledger event was written. */
  logged: boolean;
}

export interface RunHookOptions extends RunOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
}

/** Dispatch one hook. Never throws: internal errors fail open with the reason in `reason`. */
export async function runHook(name: HookName, input: HookInput, opts: RunHookOptions = {}): Promise<HookResult & { exitCode: 0 | 2; error?: string }> {
  const now = opts.now ?? new Date();
  try {
    const ctx = await hookContext(input, opts.env ?? process.env);
    const r =
      name === "plan-sync" ? await planSync(input, ctx, now) : name === "test-freeze" ? testFreeze(input, ctx, now) : await verifyBeforeDone(input, ctx, now, opts);
    return { ...r, exitCode: r.allowed ? 0 : 2 };
  } catch (e) {
    return { allowed: true, reason: `hook ${name} failed open: ${(e as Error).message}`, logged: false, exitCode: 0, error: (e as Error).message };
  }
}

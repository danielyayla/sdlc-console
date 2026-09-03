import { compileGlobs, isGlob, type RoundResult } from "@sdlc/schemas";
import type { ChangeView } from "../derive.js";
import { eventsNamed } from "../events.js";
import type { ChangeFiles } from "../repo.js";

export interface CheckResult {
  allowed: boolean;
  /** Message for the agent (exit 2 body when blocked). */
  reason: string;
  /** Files that caused the block, if any. */
  offending: string[];
}

function planMatcher(planFiles: readonly string[]): (path: string) => boolean {
  const exact = new Set(planFiles.filter((p) => !isGlob(p)));
  const globs = compileGlobs(planFiles.filter(isGlob));
  return (path) => exact.has(path) || globs(path);
}

/**
 * plan-sync (commit, block): every committed file is listed in plan.md's
 * "Files that change", or plan.md itself is in the same commit (FR-41).
 */
export function planSync(diffFiles: readonly string[], planFiles: readonly string[], planPath: string): CheckResult {
  if (diffFiles.includes(planPath)) {
    return { allowed: true, reason: "plan.md changes in the same commit — plan revision recorded", offending: [] };
  }
  const inPlan = planMatcher(planFiles);
  const offending = diffFiles.filter((f) => !inPlan(f) && !f.startsWith("sdlc/changes/"));
  if (offending.length === 0) return { allowed: true, reason: "all files are in the plan", offending: [] };
  return {
    allowed: false,
    reason: `files outside plan.md "Files that change": ${offending.join(", ")} — update plan.md in the same commit or stay within the plan`,
    offending,
  };
}

/**
 * test-freeze (edit, block): while a repro test is committed and the change is
 * in Build/Test, edits under the test globs are blocked; one lift per file is
 * honoured when a `freeze.lifted` event names it (FR-40/FR-51).
 */
export function testFreeze(path: string, view: ChangeView, files: ChangeFiles | null, testGlobs: readonly string[]): CheckResult {
  const frozen = view.repro?.state === "committed" && (view.stage === 3 || view.stage === 4);
  if (!frozen) return { allowed: true, reason: "no test freeze active", offending: [] };
  const underTests = compileGlobs(testGlobs)(path) || path === view.repro?.testPath;
  if (!underTests) return { allowed: true, reason: "not a test file", offending: [] };
  const lifted = files ? eventsNamed(files.events, "freeze.lifted").some((e) => e.data.path === path && e.cycle === view.cycle) : false;
  if (lifted) return { allowed: true, reason: `freeze lifted once for ${path}`, offending: [] };
  return {
    allowed: false,
    reason: `test freeze: ${path} is under the test globs while the repro test ${view.repro?.testPath ?? ""} is committed — propose the test change instead, or ask the engineer to lift the freeze once`,
    offending: [path],
  };
}

export interface RoundLike {
  n: number;
  results: readonly RoundResult[];
}

/** verify-before-done (stop, block): the latest round must be all-green with output attached (FR-40, spec 5B.2). */
export function verifyBeforeDone(rounds: readonly RoundLike[]): CheckResult {
  const last = rounds.at(-1);
  if (!last || last.results.length === 0) {
    return { allowed: false, reason: "no verification round recorded — run the verification commands before reporting done", offending: [] };
  }
  const failing = last.results.filter((r) => !r.pass).map((r) => r.name);
  if (failing.length > 0) {
    return { allowed: false, reason: `verify-before-done: round ${last.n} has ${failing.join(", ")} red — completion blocked`, offending: failing };
  }
  const silent = last.results.filter((r) => r.outputExcerpt.trim() === "").map((r) => r.name);
  if (silent.length > 0) {
    return { allowed: false, reason: `verify-before-done: round ${last.n} has no output attached for ${silent.join(", ")}`, offending: silent };
  }
  return { allowed: true, reason: `round ${last.n} green with output`, offending: [] };
}

export const check = { planSync, testFreeze, verifyBeforeDone };

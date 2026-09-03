import { compileGlobs, isGlob, type EvalCase, type VerificationContract } from "@sdlc/schemas";
import type { ResolvedConfig } from "./config.js";

export interface EligibilityTerm {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Eligibility {
  value: boolean;
  terms: EligibilityTerm[];
}

export interface EligibilityInputs {
  specCommitted: boolean;
  risk: "routine" | "high";
  planFiles: readonly string[] | null;
  activeCases: readonly EvalCase[];
  verification: VerificationContract | null;
  config: ResolvedConfig;
}

/** Does an active eval case cover a planned path (exact or glob, either side)? */
function coveredByCases(path: string, cases: readonly EvalCase[]): boolean {
  for (const c of cases) {
    if (c.paths.some((p) => p === path)) return true;
    const globs = c.paths.filter(isGlob);
    if (globs.length > 0 && compileGlobs(globs)(path)) return true;
    if (isGlob(path) && c.paths.some((p) => compileGlobs([path])(p))) return true;
  }
  return false;
}

const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl)$/i;
const UI_DIR = /(^|\/)(web|ui|frontend|client|components?|views?|pages|screens|layouts?|styles?)\//i;

/** Planned paths that are UI work (spec 5B: "no visual tool + plan touches UI paths → UI work without a visual check"). */
export function uiPaths(planFiles: readonly string[]): string[] {
  return planFiles.filter((f) => UI_EXT.test(f) || UI_DIR.test(f));
}

/**
 * The verification term (FR-34, spec 5B.1): not just a block, a loop the
 * session can actually run — every command single-target, a test target, and a
 * visual tool when the plan touches UI paths.
 */
export function verificationTerm(verification: VerificationContract | null, planFiles: readonly string[] | null): EligibilityTerm {
  const name = "verification block present";
  const commands = verification?.commands ?? [];
  if (!verification || commands.length === 0) return { name, ok: false, detail: "no feedback loop — set up verification in CLAUDE.md" };
  const multi = commands.filter((c) => !c.singleTarget);
  if (multi.length > 0) return { name, ok: false, detail: `${multi.map((c) => c.name).join(", ")} chain${multi.length === 1 ? "s" : ""} commands — wrap in one target` };
  if (!commands.some((c) => c.name === "test")) return { name, ok: false, detail: "no test target in CLAUDE.md — the loop cannot tell red from green" };
  const ui = uiPaths(planFiles ?? []);
  if (ui.length > 0 && verification.visualTool === null) return { name, ok: false, detail: `UI work without a visual check — ${ui.length} UI path${ui.length === 1 ? "" : "s"} in plan and no Visual: line in CLAUDE.md` };
  const n = commands.length;
  return { name, ok: true, detail: `${n} single-target command${n === 1 ? "" : "s"} in CLAUDE.md, test target present${ui.length > 0 ? `, visual tool ${verification.visualTool} for ${ui.length} UI path${ui.length === 1 ? "" : "s"}` : ""}` };
}

/** AUTO eligibility (FR-34): derived, never a toggle. */
export function deriveEligibility(i: EligibilityInputs): Eligibility {
  const t = i.config.thresholds;
  const terms: EligibilityTerm[] = [];

  terms.push({
    name: "spec committed",
    ok: i.specCommitted,
    detail: i.specCommitted ? "spec.md accepted at gate 2" : "spec.md not yet accepted",
  });
  terms.push({
    name: "risk routine",
    ok: i.risk === "routine",
    detail: i.risk === "routine" ? "routine" : "high risk — supervised only",
  });

  const files = i.planFiles;
  const count = files?.length ?? 0;
  terms.push({
    name: `files in plan ≤ ${t.autoFilesMax}`,
    ok: files !== null && count > 0 && count <= t.autoFilesMax,
    detail: files === null ? "no plan.md" : count === 0 ? "plan lists no files" : `${count} file${count === 1 ? "" : "s"} in plan`,
  });

  let coverageOk = false;
  let coverageDetail = "no plan.md";
  if (files !== null && count > 0) {
    const uncovered = files.filter((f) => !coveredByCases(f, i.activeCases));
    const strict = uncovered.length === 0;
    const hasTestCommand = i.verification?.commands.some((c) => c.name === "test") ?? false;
    const hasGlobs = (i.verification?.testGlobs.length ?? 0) > 0;
    if (i.config.eligibility.coverage === "strict") {
      coverageOk = strict;
      coverageDetail = strict ? "every planned path has an active eval case" : `${uncovered.length} path${uncovered.length === 1 ? "" : "s"} without an active eval case`;
    } else {
      coverageOk = strict || (hasTestCommand && hasGlobs);
      coverageDetail = strict
        ? "every planned path has an active eval case"
        : hasTestCommand && hasGlobs
          ? "verification includes a test target and test globs (lenient coverage)"
          : hasTestCommand
            ? "no active eval case for planned paths and no test globs declared in CLAUDE.md"
            : "no active eval case for planned paths and no test target";
    }
  }
  terms.push({ name: "eval coverage for paths", ok: coverageOk, detail: coverageDetail });

  terms.push(verificationTerm(i.verification, files));

  return { value: terms.every((x) => x.ok), terms };
}

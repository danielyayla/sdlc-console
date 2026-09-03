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
    if (i.config.eligibility.coverage === "strict") {
      coverageOk = strict;
      coverageDetail = strict ? "every planned path has an active eval case" : `${uncovered.length} path${uncovered.length === 1 ? "" : "s"} without an active eval case`;
    } else {
      coverageOk = strict || hasTestCommand;
      coverageDetail = strict
        ? "every planned path has an active eval case"
        : hasTestCommand
          ? "verification includes a test target (lenient coverage)"
          : "no active eval case for planned paths and no test target";
    }
  }
  terms.push({ name: "eval coverage for paths", ok: coverageOk, detail: coverageDetail });

  const verificationPresent = (i.verification?.commands.length ?? 0) > 0;
  terms.push({
    name: "verification block present",
    ok: verificationPresent,
    detail: verificationPresent ? `${i.verification?.commands.length} command${i.verification?.commands.length === 1 ? "" : "s"} in CLAUDE.md` : "no feedback loop — set up verification in CLAUDE.md",
  });

  return { value: terms.every((x) => x.ok), terms };
}

import type { EvalRun } from "@sdlc/schemas";
import { orderedRuns } from "./evals.js";
import type { Repo } from "./repo.js";

/**
 * Skills table (spec 5A.3, build-order 2.8): advisory unless a hook backs
 * them; pass % = share of trigger-test prompts that loaded the skill, from
 * the latest complete suite run; Stage 5 findings citing the policy counted
 * onto the row. Pure derivation, nothing stored.
 */
export interface SkillStatus {
  name: string;
  trigger: string;
  owner: string | null;
  /** Blob sha of SKILL.md (short), the version the fingerprint records. */
  version: string | null;
  backedBy: string | null;
  /** `hook`: the named hook is in settings; `unknown-hook`: named but not installed; `advisory`: none named. */
  backing: "hook" | "unknown-hook" | "advisory";
  backingScope: "managed" | "team" | null;
  mustHold: boolean;
  /** Must hold, but nothing deterministic enforces it. */
  mustHoldWithoutHook: boolean;
  /** Trigger tests: cases with `skill: <name>`. */
  triggerTests: { total: number; active: number };
  /** The run the pass % comes from. */
  run: string | null;
  passed: number | null;
  passPct: number | null;
  passNote: string;
  belowThreshold: boolean;
  findingsCiting: number;
}

/** The latest complete run that has a result for at least one of the case ids. */
function runWithResults(runs: EvalRun[], caseIds: ReadonlySet<string>): EvalRun | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r && r.results.some((x) => caseIds.has(x.caseId))) return r;
  }
  return null;
}

export function skillStatus(repo: Pick<Repo, "skills" | "settings" | "fingerprint" | "evalCases" | "evalRuns" | "config" | "changes">): SkillStatus[] {
  const threshold = repo.config.thresholds.skillPassThreshold;
  const runs = orderedRuns(repo, true);
  const hooks = repo.settings?.hooks ?? [];
  const findings = [...repo.changes.values()].flatMap((f) => f.events).filter((e) => e.event === "review.finding");
  return repo.skills.map((s) => {
    const hook = s.backedBy ? (hooks.find((h) => h.name === s.backedBy) ?? null) : null;
    const backing: SkillStatus["backing"] = s.backedBy ? (hook ? "hook" : "unknown-hook") : "advisory";
    const tests = repo.evalCases.filter((c) => c.skill === s.name);
    const active = tests.filter((c) => c.status === "active");
    const ids = new Set(active.map((c) => c.id));
    const run = active.length > 0 ? runWithResults(runs, ids) : null;
    const results = run ? run.results.filter((r) => ids.has(r.caseId)) : [];
    const passed = run ? results.filter((r) => r.pass).length : null;
    const passPct = run && results.length > 0 ? Math.round((results.filter((r) => r.pass).length / results.length) * 100) : null;
    const passNote = active.length === 0 ? (tests.length === 0 ? "n/a · needs trigger tests" : `n/a · ${tests.length} trigger test${tests.length === 1 ? "" : "s"} not active`) : run ? `${passed} of ${results.length} trigger prompts loaded it (${run.id})` : "n/a · no complete suite run covers its trigger tests";
    const word = new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const citing = findings.filter((e) => e.event === "review.finding" && (word.test(e.data.title) || word.test(e.data.detail ?? ""))).length;
    return {
      name: s.name,
      trigger: s.trigger,
      owner: s.owner,
      version: repo.fingerprint.skills.find((x) => x.name === s.name)?.version.slice(0, 7) ?? null,
      backedBy: s.backedBy,
      backing,
      backingScope: hook ? hook.scope : null,
      mustHold: s.mustHold,
      mustHoldWithoutHook: s.mustHold && backing !== "hook",
      triggerTests: { total: tests.length, active: active.length },
      run: run?.id ?? null,
      passed,
      passPct,
      passNote,
      belowThreshold: passPct !== null && passPct / 100 < threshold,
      findingsCiting: citing,
    };
  });
}

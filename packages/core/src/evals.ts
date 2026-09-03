import type { ConfigRef, EvalCase, EvalResult, EvalRun } from "@sdlc/schemas";
import { fingerprintMatches } from "./fingerprint.js";
import { nextId } from "./ids.js";
import type { Repo } from "./repo.js";

/**
 * Eval suite (blueprint FR-52/53, build-order 2.5): pure rules over the
 * committed cases and runs. The runner (server) executes checks and writes a
 * run file; everything here is derivation.
 */

export const BUDGET_WINDOW_DAYS = 30;

/** Cases the suite runs and counts: `draft` (checks pending) and `retired` never enter the pass rate. */
export function activeCases(repo: Pick<Repo, "evalCases">): EvalCase[] {
  return repo.evalCases.filter((c) => c.status === "active");
}

/** Pass ⇔ every active case ran and the rate meets the threshold; a stopped run is `incomplete` and never a pass. */
export function suiteVerdict(passRate: number, threshold: number, complete: boolean): EvalRun["verdict"] {
  if (!complete) return "incomplete";
  return passRate >= threshold ? "pass" : "fail";
}

export function nextRunId(runs: readonly Pick<EvalRun, "id">[]): string {
  return nextId("RUN", runs.map((r) => r.id));
}

export function nextCaseId(cases: readonly Pick<EvalCase, "id">[]): string {
  return nextId("CASE", cases.map((c) => c.id));
}

export interface BuildRunInput {
  id: string;
  trigger: EvalRun["trigger"];
  configRef: ConfigRef;
  results: EvalResult[];
  threshold: number;
  /** False when the runner stopped before every active case ran (budget). */
  complete: boolean;
  cost: number;
  startedAt: string;
  finishedAt: string;
}

export function buildEvalRun(i: BuildRunInput): EvalRun {
  const passed = i.results.filter((r) => r.pass).length;
  // nothing ran because nothing is active: nothing failed either (the under-sized warning says the rest)
  const passRate = i.results.length === 0 ? 1 : Math.round((passed / i.results.length) * 1000) / 1000;
  return { schema: 1, id: i.id, trigger: i.trigger, configRef: i.configRef, results: i.results, passRate, threshold: i.threshold, verdict: suiteVerdict(passRate, i.threshold, i.complete), cost: i.cost, startedAt: i.startedAt, finishedAt: i.finishedAt };
}

export interface Regression {
  caseId: string;
  /** Output verbatim from the earlier run (never summarised). */
  before: string;
  after: string;
}

/** Cases that passed in `prev` and fail in `cur`; and cases failing in `cur` with no earlier result. */
export function regressions(prev: EvalRun | null, cur: EvalRun): { regressed: Regression[]; newFailures: EvalResult[] } {
  const before = new Map((prev?.results ?? []).map((r) => [r.caseId, r]));
  const regressed: Regression[] = [];
  const newFailures: EvalResult[] = [];
  for (const r of cur.results) {
    if (r.pass) continue;
    const b = before.get(r.caseId);
    if (!b) newFailures.push(r);
    else if (b.pass) regressed.push({ caseId: r.caseId, before: b.output, after: r.output });
  }
  return { regressed, newFailures };
}

/** What changed in the config fingerprint between two runs, one line each. */
export function configChanges(prev: ConfigRef | null, cur: ConfigRef): string[] {
  if (!prev) return ["first run"];
  const out: string[] = [];
  if (prev.claudeMdSha !== cur.claudeMdSha) out.push(`CLAUDE.md ${prev.claudeMdSha.slice(0, 7)} → ${cur.claudeMdSha.slice(0, 7)}`);
  if (prev.hooksSha !== cur.hooksSha) out.push(`hooks ${prev.hooksSha.slice(0, 7)} → ${cur.hooksSha.slice(0, 7)}`);
  const was = new Map(prev.skills.map((s) => [s.name, s.version]));
  const now = new Map(cur.skills.map((s) => [s.name, s.version]));
  for (const [name, version] of now) {
    const v = was.get(name);
    if (v === undefined) out.push(`skill ${name} added`);
    else if (v !== version) out.push(`skill ${name} ${v.slice(0, 7)} → ${version.slice(0, 7)}`);
  }
  for (const name of was.keys()) if (!now.has(name)) out.push(`skill ${name} removed`);
  if (prev.model !== cur.model) out.push(`model ${prev.model} → ${cur.model}`);
  return out;
}

/** Runs by start time; `complete` excludes incomplete runs (they count for nothing). */
export function orderedRuns(repo: Pick<Repo, "evalRuns">, complete = false): EvalRun[] {
  const runs = [...repo.evalRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return complete ? runs.filter((r) => r.verdict !== "incomplete") : runs;
}

/** The latest run whose fingerprint matches the tree's (the run that speaks for the current config). */
export function runForCurrentConfig(repo: Pick<Repo, "evalRuns" | "fingerprint">): EvalRun | null {
  return [...orderedRuns(repo)].reverse().find((r) => fingerprintMatches(r.configRef, repo.fingerprint)) ?? null;
}

export interface GateResult {
  /** True when the config change may merge on the suite's account. */
  ok: boolean;
  /** False in scheduled mode: config PRs are not gated, whatever the runs say. */
  gated: boolean;
  run: EvalRun | null;
  /** The run the regressions are measured against (the latest earlier run under a different config, else the previous run). */
  baseline: EvalRun | null;
  regressed: Regression[];
  newFailures: EvalResult[];
  reason: string;
}

/**
 * Config-change gate (spec: "PR touching CLAUDE.md, .claude/**, model pin →
 * run as required check; below threshold blocks merge, lists regressed cases
 * with before/after"). Pure: CI calls `sdlc evals gate` after `sdlc evals run`.
 */
export function evalGate(repo: Pick<Repo, "evalRuns" | "fingerprint" | "config">, runId?: string): GateResult {
  const threshold = repo.config.evals.threshold;
  if (repo.config.evals.mode === "scheduled") return { ok: true, gated: false, run: null, baseline: null, regressed: [], newFailures: [], reason: "evals.mode is scheduled: config PRs are not gated" };
  const runs = orderedRuns(repo);
  const run = runId ? (runs.find((r) => r.id === runId) ?? null) : runForCurrentConfig(repo);
  if (!run) return { ok: false, gated: true, run: null, baseline: null, regressed: [], newFailures: [], reason: runId ? `${runId} is not under evals/runs` : "no suite run for the current config — run sdlc evals run --trigger config-pr" };
  const earlier = runs.filter((r) => r.startedAt < run.startedAt || (r.startedAt === run.startedAt && r.id < run.id)).filter((r) => r.verdict !== "incomplete");
  const baseline = [...earlier].reverse().find((r) => !fingerprintMatches(r.configRef, run.configRef)) ?? earlier.at(-1) ?? null;
  const { regressed, newFailures } = regressions(baseline, run);
  const pct = `${Math.round(run.passRate * 100)}% vs threshold ${Math.round(threshold * 100)}%`;
  if (run.verdict === "pass") return { ok: true, gated: true, run, baseline, regressed, newFailures, reason: `${run.id} pass · ${pct}` };
  if (run.verdict === "incomplete") return { ok: false, gated: true, run, baseline, regressed, newFailures, reason: `${run.id} incomplete (stopped at the budget) — incomplete never counts as pass` };
  return { ok: false, gated: true, run, baseline, regressed, newFailures, reason: `${run.id} fail · ${pct}${regressed.length > 0 ? ` · ${regressed.length} regressed` : ""}` };
}

export interface BudgetStatus {
  /** `evals.budget`, in the unit the runner records cost in (the built-in runner: minutes); null when unset. */
  limit: number | null;
  used: number;
  remaining: number | null;
  windowDays: number;
  exhausted: boolean;
}

/** Cost of the runs started in the rolling window against `evals.budget`. */
export function budgetStatus(repo: Pick<Repo, "evalRuns" | "config">, now: string, windowDays = BUDGET_WINDOW_DAYS): BudgetStatus {
  const limit = repo.config.evals.budget;
  const since = new Date(Date.parse(now) - windowDays * 86_400_000).toISOString();
  const used = Math.round(repo.evalRuns.filter((r) => r.startedAt >= since && r.startedAt <= now).reduce((a, r) => a + (r.cost ?? 0), 0) * 100) / 100;
  const remaining = limit === null ? null : Math.max(0, Math.round((limit - used) * 100) / 100);
  return { limit, used, remaining, windowDays, exhausted: limit !== null && used >= limit };
}

export interface SuiteStatus {
  mode: "continuous" | "scheduled";
  threshold: number;
  active: number;
  draft: number;
  retired: number;
  underSized: boolean;
  suiteMinSize: number;
  latest: EvalRun | null;
  /** The run that speaks for the tree's current config, if any. */
  current: EvalRun | null;
  gate: GateResult;
  budget: BudgetStatus;
  /** One line per run in the strip: what changed in the config since the run before it. */
  strip: { id: string; verdict: EvalRun["verdict"]; passRate: number; trigger: EvalRun["trigger"]; startedAt: string; model: string; changes: string[] }[];
}

/** Everything the Config view's evals section shows, computed once per snapshot. */
export function suiteStatus(repo: Pick<Repo, "evalCases" | "evalRuns" | "fingerprint" | "config">, now: string): SuiteStatus {
  const runs = orderedRuns(repo);
  const strip = runs.slice(-30).map((r) => {
    const i = runs.indexOf(r);
    const prev = i > 0 ? (runs[i - 1] ?? null) : null;
    return { id: r.id, verdict: r.verdict, passRate: r.passRate, trigger: r.trigger, startedAt: r.startedAt, model: r.configRef.model, changes: configChanges(prev?.configRef ?? null, r.configRef) };
  });
  const active = activeCases(repo).length;
  return {
    mode: repo.config.evals.mode,
    threshold: repo.config.evals.threshold,
    active,
    draft: repo.evalCases.filter((c) => c.status === "draft").length,
    retired: repo.evalCases.filter((c) => c.status === "retired").length,
    underSized: active < repo.config.thresholds.suiteMinSize,
    suiteMinSize: repo.config.thresholds.suiteMinSize,
    latest: runs.at(-1) ?? null,
    current: runForCurrentConfig(repo),
    gate: evalGate(repo),
    budget: budgetStatus(repo, now),
    strip,
  };
}

export interface EvalSignal {
  kind: "retire" | "broken";
  caseId: string;
  /** Runs that make the streak, oldest first. */
  runs: string[];
  /** Dedupe key, also the triage item's `src`. */
  src: string;
  title: string;
  evidence: string;
}

/**
 * Live-suite signals (spec: "100% over N runs → no longer discriminates";
 * "failing 3 runs, no config change → broken check"). Only complete runs
 * count, only active cases are judged, and a streak needs the full N/M runs.
 */
export function evalSignals(repo: Pick<Repo, "evalCases" | "evalRuns" | "config">): EvalSignal[] {
  const n = repo.config.thresholds.noDiscriminationRuns;
  const m = repo.config.thresholds.brokenCheckRuns;
  const runs = orderedRuns(repo, true);
  const out: EvalSignal[] = [];
  for (const c of activeCases(repo)) {
    const history = runs.map((r) => ({ run: r, result: r.results.find((x) => x.caseId === c.id) ?? null })).filter((h): h is { run: EvalRun; result: EvalResult } => h.result !== null);
    const lastN = history.slice(-n);
    if (lastN.length >= n && lastN.every((h) => h.result.pass)) {
      out.push({ kind: "retire", caseId: c.id, runs: lastN.map((h) => h.run.id), src: `eval-retire:${c.id}`, title: `${c.id} no longer discriminates (100% over ${n} runs)`, evidence: `${c.id} passed in ${n} consecutive suite runs (${lastN[0]?.run.id} … ${lastN.at(-1)?.run.id}); a case that cannot fail measures nothing — retire it or harden its checks.` });
      continue;
    }
    const lastM = history.slice(-m);
    const first = lastM[0];
    if (first && lastM.length >= m && lastM.every((h) => !h.result.pass) && lastM.every((h) => fingerprintMatches(h.run.configRef, first.run.configRef))) {
      out.push({ kind: "broken", caseId: c.id, runs: lastM.map((h) => h.run.id), src: `eval-broken:${c.id}`, title: `${c.id}: broken check (failing ${m} runs, no config change)`, evidence: `${c.id} failed in ${m} consecutive suite runs (${first.run.id} … ${lastM.at(-1)?.run.id}) under the same CLAUDE.md, hooks and skills; nothing the suite guards changed, so the check itself is suspect. Last output:\n${lastM.at(-1)?.result.output ?? ""}` });
    }
  }
  return out;
}

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitWritePlan, git, readTree, removeWorktree } from "@sdlc/adapter-git";
import { activeCases, budgetStatus, buildEvalRun, configFingerprint, loadRepo, nextRunId, raiseEvalSignals, UNPINNED_MODEL, validateWritePlan, type EvalSignal, type Repo, type WritePlan } from "@sdlc/core";
import { stringifyJson, type EvalResult, type EvalRun } from "@sdlc/schemas";
import { SYSTEM_IDENTITY } from "./codehost.js";
import type { Exec } from "./runner.js";

export interface SuiteInput {
  root: string;
  repo: Repo;
  trigger: EvalRun["trigger"];
  /** Commit to run the checks against (default HEAD). */
  ref?: string;
  exec?: Exec;
  timeoutMs?: number;
  now?: () => Date;
  /** Monotonic ms clock for the cost (tests inject one). */
  clock?: () => number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface SuiteOutcome {
  /** Set when nothing ran (scheduled mode refuses the config-pr trigger). */
  skipped: string | null;
  run: EvalRun | null;
  commit: string | null;
  /** Triage items raised from this run's streaks. */
  signals: EvalSignal[];
  signalsCommit: string | null;
}

function shell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode: code, output: `${stdout}${stderr ? `\n${stderr}` : ""}` });
    });
  });
}

const EXCERPT = 8_000;

/**
 * Eval suite run (FR-52, build-order 2.5): every active case's checks in a
 * detached worktree at `ref`, output kept verbatim, cost = elapsed minutes.
 * The run file is committed on the current branch as sdlc-bot (CI commits it
 * on the PR branch, the console on the default branch); then the live-suite
 * signals are raised as triage items. Draft and retired cases never run.
 */
export async function runSuite(input: SuiteInput): Promise<SuiteOutcome> {
  const { repo, trigger } = input;
  const iso = () => (input.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (repo.config.evals.mode === "scheduled" && trigger === "config-pr") return { skipped: "evals.mode is scheduled: config PRs are not gated", run: null, commit: null, signals: [], signalsCommit: null };
  const startedAt = iso();
  const budget = budgetStatus(repo, startedAt);
  if (budget.exhausted) throw new Error(`budget exhausted: ${budget.used} of ${budget.limit} used in the last ${budget.windowDays} days`);
  const exec = input.exec ?? ((c, d) => shell(c, d, input.timeoutMs ?? 15 * 60_000));
  const clock = input.clock ?? (() => Date.now());
  mkdirSync(join(input.root, ".sdlc-state", "worktrees"), { recursive: true });
  const dir = mkdtempSync(join(input.root, ".sdlc-state", "worktrees", "evals-"));
  rmSync(dir, { recursive: true, force: true });
  await git(input.root, ["worktree", "add", "--quiet", "--detach", dir, input.ref ?? "HEAD"]);
  try {
    const tree = await readTree(dir, "HEAD");
    const configRef = { ...configFingerprint(tree), model: input.env?.["SDLC_MODEL"] ?? UNPINNED_MODEL };
    const cases = [...activeCases(repo)].sort((a, b) => a.id.localeCompare(b.id));
    const results: EvalResult[] = [];
    const t0 = clock();
    let complete = true;
    const cost = () => Math.round(((clock() - t0) / 60_000) * 100) / 100;
    for (const c of cases) {
      if (budget.limit !== null && budget.used + cost() >= budget.limit) {
        complete = false;
        input.log?.(`[evals] budget reached after ${results.length} of ${cases.length} cases; the run is incomplete`);
        break;
      }
      let pass = true;
      let output = "";
      for (const chk of c.checks) {
        const r = await exec(chk.cmd, dir);
        const ok = r.exitCode === 0 && (!chk.healthyOutput || r.output.includes(chk.healthyOutput));
        output += `--- ${chk.name}: ${chk.cmd} (exit ${r.exitCode})\n${r.output.slice(-EXCERPT)}\n`;
        if (!ok) pass = false;
      }
      results.push({ caseId: c.id, pass, output });
    }
    const run = buildEvalRun({ id: nextRunId(repo.evalRuns), trigger, configRef, results, threshold: repo.config.evals.threshold, complete, cost: cost(), startedAt, finishedAt: iso() });
    const passed = results.filter((r) => r.pass).length;
    const plan: WritePlan = {
      changeId: null,
      files: [{ path: `evals/runs/${run.id}.json`, content: stringifyJson(run) }],
      events: [],
      commitMessage: `sdlc(evals): suite run ${run.id} ${run.verdict} (${passed}/${results.length} of ${cases.length}${complete ? "" : " · stopped at the budget"})`,
      trailers: { "SDLC-Actor": `system:${SYSTEM_IDENTITY.id}` },
      actor: { type: "system", id: SYSTEM_IDENTITY.id },
    };
    const report = validateWritePlan(repo, plan);
    if (report.blocking) throw new Error(`suite run rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
    const commit = await commitWritePlan(input.root, plan, { identity: SYSTEM_IDENTITY });
    input.log?.(`[evals] ${run.id} ${run.verdict} (${passed}/${results.length}) committed ${commit.slice(0, 7)}`);
    // live-suite signals over the committed history, including this run
    const after = loadRepo(await readTree(input.root, "HEAD"));
    const raised = raiseEvalSignals(after, { now: iso() });
    let signalsCommit: string | null = null;
    let signals: EvalSignal[] = [];
    if (raised.ok) {
      const check = validateWritePlan(after, raised.plan);
      if (check.blocking) throw new Error(`eval signals rejected by validation: ${check.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
      signalsCommit = await commitWritePlan(input.root, raised.plan, { identity: SYSTEM_IDENTITY });
      signals = raised.signals ?? [];
      input.log?.(`[evals] ${signals.length} triage item(s) raised: ${signals.map((s) => `${s.kind} ${s.caseId}`).join(", ")}`);
    }
    return { skipped: null, run, commit, signals, signalsCommit };
  } finally {
    await removeWorktree(input.root, dir, true).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

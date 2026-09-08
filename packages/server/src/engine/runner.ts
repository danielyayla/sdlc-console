import { execFile } from "node:child_process";
import { commitWritePlan, git, headSha, newUlid, readTree } from "@sdlc/adapter-git";
import { check, configFingerprint, intersectingCases, loadRepo, type ChangeView, type Repo, type WritePlan } from "@sdlc/core";
import { compileGlobs, stringifyJson, type AutoFinding, type CommandResult, type Event, type EvalResult, type PerChangeRun, type Pr } from "@sdlc/schemas";
import type { Env } from "@sdlc/adapter-github";
import { SYSTEM_IDENTITY, codeHostFor, type CodeHost } from "./codehost.js";
import { noopTracer, type Span, type SpanContext, type Tracer } from "../otel.js";

export interface Exec {
  (cmd: string, cwd: string): Promise<{ exitCode: number; output: string }>;
}

function shell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode: code, output: `${stdout}${stderr ? `\n${stderr}` : ""}` });
    });
  });
}

export interface RunInput {
  root: string;
  view: ChangeView;
  /** Task worktree checkout (code under test). */
  worktree: string;
  branch: string;
  exec?: Exec;
  timeoutMs?: number;
  now?: () => Date;
  /** Code host override (tests); otherwise `config.codeHost` + `env`. */
  codeHost?: CodeHost;
  env?: Env;
  /** OTel (3.3): the run's `sdlc.run.per-change` span, a child of `parent` (the job's span) when given. */
  tracer?: Tracer;
  parent?: SpanContext | Span | null;
  /**
   * Whether the session that produced the diff ran plan-sync and test-freeze
   * in-process (3.8). False for a harness without a PreToolUse hook: the run
   * then checks the diff against plan.md (`plan-sync` check) and raises the
   * test-freeze auto-findings whatever `.claude/settings.json` declares.
   * Default true (a manual run has no session; the settings decide).
   */
  hooksInSession?: boolean;
}

export interface RunOutcome {
  run: PerChangeRun;
  runCommit: string;
  /** Present when the run was green and the PR was opened or its head synchronized. */
  prCommit: string | null;
  /** What a green run did about the PR: opened it, moved its head, or found it already at this head. */
  prAction: "opened" | "synchronized" | "unchanged" | null;
  consecutiveReds: number;
}

const EXCERPT = 20_000;

function systemEvent<N extends Event["event"]>(name: N, cycle: number, seq: number, now: string, data: Extract<Event, { event: N }>["data"]): Event {
  return { schema: 1, id: newUlid(), ts: now, seq, cycle, actor: { type: "system", id: SYSTEM_IDENTITY.id }, event: name, data } as unknown as Event;
}

/**
 * Per-change run (Stage 04): verification commands from CLAUDE.md plus the
 * checks of active eval cases whose paths intersect the diff, executed in the
 * task worktree. The run record and its verdict are committed on the default
 * branch by sdlc-bot; green opens the PR (local mode: pr.yaml) → stage 5.
 */
export async function runPerChange(input: RunInput, repo: Repo): Promise<RunOutcome> {
  const span = (input.tracer ?? noopTracer).startSpan("sdlc.run.per-change", { attributes: { "sdlc.change": input.view.id, "sdlc.cycle": input.view.cycle, "sdlc.stage": input.view.stage, "sdlc.branch": input.branch }, parent: input.parent ?? null });
  try {
    const outcome = await runPerChangeSpanned(input, repo);
    const run = outcome.run;
    for (const r of run.commandResults) span.addEvent("sdlc.run.command", { "sdlc.command.name": r.name, "sdlc.command.exit_code": r.exitCode, "sdlc.command.pass": r.pass });
    for (const r of run.results) span.addEvent("sdlc.run.case", { "sdlc.case.id": r.caseId, "sdlc.case.pass": r.pass });
    span.setAttributes({ "sdlc.run.n": run.n, "sdlc.run.verdict": run.verdict, "sdlc.run.head": run.headSha, "sdlc.run.commit": outcome.runCommit, "sdlc.run.commands.passed": run.commandResults.filter((r) => r.pass).length, "sdlc.run.commands.total": run.commandResults.length, "sdlc.run.cases.passed": run.results.filter((r) => r.pass).length, "sdlc.run.cases.total": run.results.length, "sdlc.run.pr_action": outcome.prAction, "sdlc.run.consecutive_reds": outcome.consecutiveReds });
    span.end({ ok: true });
    return outcome;
  } catch (e) {
    span.end({ ok: false, message: (e as Error).message });
    throw e;
  }
}

async function runPerChangeSpanned(input: RunInput, repo: Repo): Promise<RunOutcome> {
  const now = () => (input.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const exec = input.exec ?? ((c, d) => shell(c, d, input.timeoutMs ?? 15 * 60_000));
  const view = input.view;
  const files = repo.changes.get(view.id);
  if (!files?.change) throw new Error(`${view.id} not loaded`);
  const base = repo.config.defaultBranch;
  const head = await headSha(input.worktree, "HEAD");
  // code under test: lifecycle records under sdlc/changes/ (ledger, session events) are not part of the diff
  const fileSet = (await git(input.root, ["diff", "--name-only", `${base}...${input.branch}`])).split("\n").map((s) => s.trim()).filter((p) => p !== "" && !p.startsWith("sdlc/changes/"));
  const worktreeRepo = loadRepo(await readTree(input.worktree, "HEAD"));
  const contract = worktreeRepo.verification ?? repo.verification;
  const startedAt = now();

  const commandResults: CommandResult[] = [];
  for (const c of contract?.commands ?? []) {
    if (c.name === "visual") continue;
    const r = await exec(c.cmd, input.worktree);
    const healthy = c.healthyOutput ? r.exitCode === 0 || r.output.includes(c.healthyOutput) : r.exitCode === 0;
    commandResults.push({ name: c.name, cmd: c.cmd, exitCode: r.exitCode, pass: r.exitCode === 0 && healthy, output: r.output.slice(-EXCERPT) });
  }
  const cases = intersectingCases(fileSet.length > 0 ? fileSet : view.planFiles, repo.evalCases);
  const results: EvalResult[] = [];
  for (const c of cases) {
    let pass = true;
    let output = "";
    for (const chk of c.checks) {
      const r = await exec(chk.cmd, input.worktree);
      const ok = r.exitCode === 0 && (!chk.healthyOutput || r.output.includes(chk.healthyOutput));
      output += `--- ${chk.name}: ${chk.cmd} (exit ${r.exitCode})\n${r.output.slice(-4000)}\n`;
      if (!ok) pass = false;
    }
    results.push({ caseId: c.id, pass, output });
  }
  const green = (contract?.commands.length ?? 0) > 0 && commandResults.every((r) => r.pass) && results.every((r) => r.pass);
  const n = files.runs.filter((r) => r.cycle === view.cycle).length + 1;
  const run: PerChangeRun = {
    schema: 1,
    n,
    changeId: view.id,
    cycle: view.cycle,
    worktree: input.branch,
    headSha: head,
    fileSet,
    configRef: configFingerprint(worktreeRepo.tree),
    results,
    commandResults,
    verdict: green ? "green" : "red",
    startedAt,
    finishedAt: now(),
  };
  const seq = Math.max(0, ...files.events.map((e) => e.seq)) + 1;
  const total = commandResults.length + results.length;
  const passed = commandResults.filter((r) => r.pass).length + results.filter((r) => r.pass).length;
  const events = [systemEvent(green ? "evals.green" : "evals.red", view.cycle, seq, now(), { run: `run-${n}`, passed, total })];
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path: `${files.dir}/evals/run-${n}.json`, content: stringifyJson(run) }],
    events: events.map((event) => ({ changeId: view.id, event })),
    commitMessage: `sdlc(${view.id}): per-change run ${n} ${run.verdict} (${passed}/${total})`,
    trailers: { "SDLC-Event": events[0]?.id ?? "", "SDLC-Actor": `system:${SYSTEM_IDENTITY.id}` },
    actor: { type: "system", id: SYSTEM_IDENTITY.id },
  };
  const runCommit = await commitWritePlan(input.root, plan, { identity: SYSTEM_IDENTITY });

  let prCommit: string | null = null;
  let prAction: RunOutcome["prAction"] = null;
  let reds = 0;
  if (green) {
    const planMatches = view.planMatches ?? check.planSync(fileSet, view.planFiles, `${files.dir}/plan.md`).allowed;
    const host = input.codeHost ?? codeHostFor(repo.config.codeHost, input.env);
    const cmdPassed = commandResults.filter((r) => r.pass).length;
    const casesPassed = results.filter((r) => r.pass).length;
    // the evidence travels verbatim: a GitHub App puts it in the check run's text (3.2); a token carries the one-line summary only
    const checks: { name: string; verdict: "pass" | "fail"; summary: string; evidence?: string }[] = [
      { name: "evidence", verdict: "pass" as const, summary: `per-change run ${n} green · ${cmdPassed}/${commandResults.length} verification commands passed`, evidence: commandResults.map((r) => `--- ${r.name}: ${r.cmd} (exit ${r.exitCode})\n${r.output}`).join("\n") },
      { name: "evals", verdict: "pass" as const, summary: results.length === 0 ? `per-change run ${n} · no eval cases intersect the diff` : `per-change run ${n} · ${casesPassed}/${results.length} intersecting eval cases passed`, evidence: results.length === 0 ? "no eval cases intersect the diff" : results.map((r) => `--- eval ${r.caseId}: ${r.pass ? "pass" : "fail"}\n${r.output}`).join("\n") },
    ];
    const existing = files.pr && files.pr.mergedAt === undefined && files.pr.branch === input.branch ? files.pr : null;
    const proof = await reproProof(input, repo, view, contract?.testGlobs ?? [], existing);
    checks.push(...proof.checks);
    if (input.hooksInSession === false) {
      // the session's harness has no PreToolUse hook (3.8): the plan-sync rule is applied to the diff here, as a check on the PR, verbatim
      const sync = check.planSync(fileSet, view.planFiles, `${files.dir}/plan.md`);
      checks.push({ name: "plan-sync", verdict: sync.allowed ? "pass" : "fail", summary: `no PreToolUse hook in the session — checked on the run: ${sync.reason}` });
    }
    const prInput = { root: input.root, view, branch: input.branch, baseBranch: base, headSha: head, planMatches, nextSeq: seq + 1, now: now(), checks, ...(proof.autoFindings.length > 0 ? { autoFindings: proof.autoFindings } : {}) };
    if (existing && existing.headSha === head) {
      // the PR already points at this head (a re-run): nothing to record on it
      prAction = "unchanged";
    } else if (existing) {
      // the head moved (a push delivered as pull_request.synchronize, or new local commits): the same PR follows the tested head
      prCommit = (await host.syncPr(prInput, existing)).commit;
      prAction = "synchronized";
    } else {
      prCommit = (await host.openPr(prInput)).commit;
      prAction = "opened";
    }
  } else {
    for (let i = files.runs.length - 1; i >= 0 && files.runs[i]?.verdict === "red"; i--) reds++;
    reds += 1;
  }
  return { run, runCommit, prCommit, prAction, consecutiveReds: reds };
}

/**
 * Repro proof for a fix (spec 5B.3, FR-51): the repro test was committed
 * before the fix, is unchanged in the diff since, and passes now (the run is
 * green). Test files changed after the repro commit without a lift are the
 * freeze's business: with managed hooks installed the hook blocked the agent
 * (a human edit is theirs to make); without hooks nothing could block, so the
 * run raises one auto-finding per file that blocks the console's merge until
 * a human dismisses it with a reason.
 */
async function reproProof(input: RunInput, repo: Repo, view: ChangeView, testGlobs: readonly string[], existing: Pr | null): Promise<{ checks: { name: string; verdict: "pass" | "fail"; summary: string }[]; autoFindings: AutoFinding[] }> {
  const repro = view.repro;
  if (view.kind !== "fix" || repro?.state !== "committed" || !repro.sha || !repro.testPath) return { checks: [], autoFindings: [] };
  const sha7 = repro.sha.slice(0, 7);
  // the proof is the diff since the repro commit; a commit this clone does not have proves nothing
  const diff = await git(input.worktree, ["diff", "--name-only", `${repro.sha}..HEAD`]).catch(() => null);
  if (diff === null) return { checks: [{ name: "repro", verdict: "fail", summary: `repro test ${repro.testPath} recorded at ${sha7}, but that commit is not in this repository — the proof cannot be shown` }], autoFindings: [] };
  const since = diff.split("\n").map((s) => s.trim()).filter(Boolean);
  const lifted = new Set(view.freezeLifts.map((l) => l.path));
  const reproChanged = since.includes(repro.testPath) && !lifted.has(repro.testPath);
  const checks: { name: string; verdict: "pass" | "fail"; summary: string }[] = [
    { name: "repro", verdict: reproChanged ? "fail" : "pass", summary: `repro test ${repro.testPath} committed ${sha7} before fix · ${reproChanged ? "modified after the repro commit without a lift" : lifted.has(repro.testPath) ? "edited under a lifted freeze" : "unchanged in diff"} · passing now` },
  ];
  const underTests = compileGlobs([...testGlobs]);
  const edits = since.filter((f) => f !== repro.testPath && underTests(f) && !lifted.has(f));
  const hooksEnforced = input.hooksInSession !== false && (repo.settings?.hooks ?? []).some((h) => /test-freeze/.test(h.script) || /test-freeze/.test(h.name));
  if (edits.length === 0 || hooksEnforced) return { checks, autoFindings: [] };
  checks.push({ name: "test-freeze", verdict: "fail", summary: `${edits.length} test file${edits.length === 1 ? "" : "s"} changed after the repro commit ${sha7} with no managed hook to block it: ${edits.join(", ")}` });
  const previous = new Map((existing?.autoFindings ?? []).filter((f) => f.dismissal).map((f) => [f.path, f.dismissal]));
  const autoFindings: AutoFinding[] = edits.map((path) => {
    const carried = previous.get(path);
    return { rule: "test-freeze", path, title: "diff touches a test file during a fix", detail: `${path} changed after the repro commit ${sha7} without a freeze lift; managed hooks are not installed, so the edit was not blocked`, ...(carried ? { dismissal: carried } : {}) };
  });
  return { checks, autoFindings };
}

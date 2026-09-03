import { execFile } from "node:child_process";
import { commitWritePlan, git, headSha, newUlid, readTree } from "@sdlc/adapter-git";
import { check, configFingerprint, intersectingCases, loadRepo, type ChangeView, type Repo, type WritePlan } from "@sdlc/core";
import { stringifyJson, type CommandResult, type Event, type EvalResult, type PerChangeRun } from "@sdlc/schemas";
import { SYSTEM_IDENTITY, codeHostFor } from "./codehost.js";

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
}

export interface RunOutcome {
  run: PerChangeRun;
  runCommit: string;
  /** Present when the run was green and a PR was opened. */
  prCommit: string | null;
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
  let reds = 0;
  if (green) {
    const planMatches = view.planMatches ?? check.planSync(fileSet, view.planFiles, `${files.dir}/plan.md`).allowed;
    const host = codeHostFor(repo.config.codeHost);
    const opened = await host.openPr({ root: input.root, view, branch: input.branch, baseBranch: base, headSha: head, planMatches, nextSeq: seq + 1, now: now() });
    prCommit = opened.commit;
  } else {
    for (let i = files.runs.length - 1; i >= 0 && files.runs[i]?.verdict === "red"; i--) reds++;
    reds += 1;
  }
  return { run, runCommit, prCommit, consecutiveReds: reds };
}

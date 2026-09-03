import { commitWritePlan } from "@sdlc/adapter-git";
import { evalGate, harvestCase, validateWritePlan, type GateResult } from "@sdlc/core";
import { runSuite, type SuiteOutcome } from "@sdlc/server";
import type { EvalRun } from "@sdlc/schemas";
import { actingIdentity, assertHuman, loadCommitted, transitionContext, viewOf, type CliContext } from "../context.js";
import { CliError, type Io } from "../io.js";
import { spawn } from "node:child_process";

export interface EvalsRunOptions {
  trigger?: EvalRun["trigger"];
  ref?: string;
}

/** `sdlc evals run [--trigger schedule|config-pr|manual] [--ref]`: run the suite here and commit the run file on the current branch. */
export async function evalsRun(ctx: CliContext, opts: EvalsRunOptions): Promise<SuiteOutcome> {
  assertHuman(ctx.io);
  const trigger = opts.trigger ?? "manual";
  if (!["manual", "schedule", "config-pr"].includes(trigger)) throw new CliError("--trigger must be manual, schedule or config-pr");
  const { repo } = await loadCommitted(ctx, opts.ref ?? "HEAD");
  try {
    return await runSuite({ root: ctx.root, repo, trigger, ...(opts.ref ? { ref: opts.ref } : {}), env: ctx.io.env, log: (l) => ctx.io.stderr(`${l}\n`) });
  } catch (e) {
    throw new CliError((e as Error).message, (e as Error).message.startsWith("budget exhausted") ? 2 : 1);
  }
}

export function renderRun(o: SuiteOutcome): string {
  if (o.skipped || !o.run) return o.skipped ?? "nothing ran";
  const passed = o.run.results.filter((r) => r.pass).length;
  const lines = [`${o.run.id} ${o.run.verdict} · ${Math.round(o.run.passRate * 100)}% (${passed}/${o.run.results.length}) · threshold ${Math.round(o.run.threshold * 100)}% · cost ${o.run.cost ?? 0} · ${o.commit?.slice(0, 7) ?? ""}`];
  for (const r of o.run.results.filter((x) => !x.pass)) lines.push(`  ✗ ${r.caseId}\n${r.output.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}`);
  for (const s of o.signals) lines.push(`  triage: ${s.title}`);
  return lines.join("\n");
}

/** `sdlc evals gate [--run RUN-id]`: exit 0 when the config change may merge on the suite's account. */
export async function evalsGate(ctx: CliContext, runId?: string): Promise<GateResult> {
  const { repo } = await loadCommitted(ctx);
  return evalGate(repo, runId);
}

export function renderGate(r: GateResult): string {
  const lines = [`${r.ok ? "ok" : "blocked"}: ${r.reason}`];
  if (!r.gated) return lines.join("\n");
  if (r.baseline) lines.push(`baseline ${r.baseline.id} (${r.baseline.configRef.claudeMdSha.slice(0, 7)})`);
  for (const x of r.regressed) lines.push(`regressed ${x.caseId}\n  before:\n${x.before.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}\n  after:\n${x.after.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}`);
  for (const f of r.newFailures) lines.push(`failing (no earlier result) ${f.caseId}\n${f.output.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}`);
  return lines.join("\n");
}

/** `sdlc evals harvest <CHG>`: draft a case from a merged change. */
export async function evalsHarvest(ctx: CliContext, changeId: string): Promise<{ caseId: string; commit: string }> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const r = harvestCase(repo, viewOf(repo, changeId), transitionContext(who));
  if (!r.ok) throw new CliError(r.diagnostics[0]?.message ?? "refused", 2, r.diagnostics);
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) throw new CliError("write-plan rejected by validation", 1, report.diagnostics.filter((d) => d.blocking));
  const commit = await commitWritePlan(ctx.root, r.plan, { identity: who });
  return { caseId: r.caseId ?? "", commit };
}

export interface TriggerResult {
  skill: string;
  prompt: string;
  loaded: boolean;
  /** The harness line that loaded the skill, or the tail of the transcript when it did not. */
  evidence: string;
  exitCode: number | null;
}

/**
 * `sdlc evals trigger <skill> --prompt <text>`: the trigger-test runner
 * (spec 5A.3 "share of trigger-test prompts that loaded the skill"). Runs the
 * harness headless on the prompt and passes iff its stream shows the `Skill`
 * tool invoked with that name. This is the check command a trigger-test
 * case (`skill: <name>`) uses; the suite tallies the pass % per skill.
 */
export function evalsTrigger(io: Io, skill: string, prompt: string, opts: { claudeBin?: string; timeoutMs?: number } = {}): Promise<TriggerResult> {
  const bin = opts.claudeBin ?? io.env["SDLC_CLAUDE_BIN"] ?? "claude";
  return new Promise((resolve) => {
    const child = spawn(bin, ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns", "3", "--allowedTools", "Skill", "Read", "Grep"], { cwd: io.cwd, env: { ...io.env, SDLC_ACTOR_TYPE: "agent" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let loadedLine: string | null = null;
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 5 * 60_000);
    const scan = (chunk: string) => {
      out += chunk;
      if (loadedLine) return;
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          const v = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; name?: string; input?: { skill?: string; name?: string } }[] } };
          const uses = v.message?.content ?? [];
          if (uses.some((c) => c.type === "tool_use" && c.name === "Skill" && (c.input?.skill === skill || c.input?.name === skill))) loadedLine = line;
        } catch {
          // not a JSON line; the transcript tail is the evidence
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", scan);
    child.stderr.on("data", (c: string) => (out += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ skill, prompt, loaded: false, evidence: `harness ${bin} could not start: ${e.message}`, exitCode: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ skill, prompt, loaded: loadedLine !== null, evidence: loadedLine ?? out.slice(-4000), exitCode: code });
    });
  });
}

export function renderTrigger(r: TriggerResult): string {
  return `${r.loaded ? "loaded" : "not loaded"}: skill ${r.skill} for "${r.prompt}"${r.exitCode !== null && r.exitCode !== 0 ? ` (harness exit ${r.exitCode})` : ""}\n${r.evidence}`;
}

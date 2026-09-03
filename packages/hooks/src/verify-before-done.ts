import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, type RoundLike } from "@sdlc/core";
import type { RoundResult, VerificationContract } from "@sdlc/schemas";
import type { HookContext } from "./context.js";
import type { HookInput } from "./input.js";
import { appendHookEvent } from "./ledger.js";
import type { HookResult } from "./run.js";

export interface RunOptions {
  timeoutMs?: number;
  /** Test seam: replaces spawning a shell. */
  exec?: (cmd: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
}

function shell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode: code, output: `${stdout}${stderr ? `\n${stderr}` : ""}` });
    });
  });
}

const EXCERPT = 4000;

/** Run every verification command; the round carries verbatim output tails. */
export async function runRound(contract: VerificationContract, cwd: string, opts: RunOptions = {}): Promise<RoundResult[]> {
  const exec = opts.exec ?? ((c, d) => shell(c, d, opts.timeoutMs ?? 10 * 60_000));
  const results: RoundResult[] = [];
  for (const c of contract.commands) {
    if (c.name === "visual") continue;
    const r = await exec(c.cmd, cwd);
    const healthy = c.healthyOutput ? r.output.includes(c.healthyOutput) || r.exitCode === 0 : r.exitCode === 0;
    results.push({ name: c.name, pass: r.exitCode === 0 && healthy, exitCode: r.exitCode, outputExcerpt: r.output.trim().slice(-EXCERPT) || (r.exitCode === 0 ? "(no output)" : "") });
  }
  return results;
}

export function roundsFile(root: string, session: string): string {
  return join(root, ".sdlc-state", "sessions", session, "rounds.jsonl");
}

export function readRounds(root: string, session: string): RoundLike[] {
  const file = roundsFile(root, session);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as RoundLike);
}

/**
 * verify-before-done (stop, block): run the CLAUDE.md verification commands,
 * record the round (evidence, verbatim) and block the stop unless all green.
 */
export async function verifyBeforeDone(input: HookInput, ctx: HookContext | null, now: Date, opts: RunOptions = {}): Promise<HookResult> {
  if (input.hook_event_name !== "Stop") return { allowed: true, reason: "not a stop", logged: false };
  if (input.stop_hook_active) return { allowed: true, reason: "stop hook already active", logged: false };
  if (!ctx) return { allowed: true, reason: "no change context — verify-before-done not enforced here", logged: false };
  const contract = ctx.repo.verification;
  if (!contract || contract.commands.length === 0) {
    return { allowed: false, reason: "verify-before-done: no feedback loop — CLAUDE.md has no \"Verifying your work\" block; set up verification before reporting done", logged: false };
  }
  const previous = readRounds(ctx.root, input.session_id);
  const results = await runRound(contract, ctx.root, opts);
  const round = { n: previous.length + 1, ts: now.toISOString().replace(/\.\d{3}Z$/, "Z"), results };
  const file = roundsFile(ctx.root, input.session_id);
  mkdirSync(join(ctx.root, ".sdlc-state", "sessions", input.session_id), { recursive: true });
  appendFileSync(file, `${JSON.stringify(round)}\n`, "utf8");
  appendHookEvent(ctx.root, ctx.changeId, ctx.view.cycle, input.session_id, "round", { n: round.n, results: results.map((r) => ({ name: r.name, pass: r.pass, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}), outputExcerpt: r.outputExcerpt.slice(-600) })) }, now);
  const verdict = check.verifyBeforeDone([round]);
  if (verdict.allowed) {
    return { allowed: true, reason: `verify-before-done: round ${round.n} green (${results.map((r) => r.name).join(", ")})`, logged: true };
  }
  appendHookEvent(ctx.root, ctx.changeId, ctx.view.cycle, input.session_id, "hook.blocked", { hook: "verify-before-done", reason: verdict.reason }, now);
  const red = results.filter((r) => !r.pass).map((r) => `--- ${r.name} (exit ${r.exitCode ?? "?"}) ---\n${r.outputExcerpt}`).join("\n");
  return { allowed: false, reason: `${verdict.reason}\n${red}`, logged: true };
}

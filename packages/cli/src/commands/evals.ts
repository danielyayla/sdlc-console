import { commitWritePlan } from "@sdlc/adapter-git";
import { evalGate, harvestCase, validateWritePlan, type GateResult } from "@sdlc/core";
import { runSuite, type SuiteOutcome } from "@sdlc/server";
import type { EvalRun } from "@sdlc/schemas";
import { actingIdentity, assertHuman, loadCommitted, transitionContext, viewOf, type CliContext } from "../context.js";
import { CliError } from "../io.js";

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

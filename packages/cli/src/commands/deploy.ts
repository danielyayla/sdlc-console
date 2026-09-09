import { codeHostFor, deployEnvironment, rehearseRollback, rollbackCheckFor, StateStore, ActionError } from "@sdlc/server";
import { check, deriveChange, productionEnvironment, type ChangeView } from "@sdlc/core";
import { actingIdentity, assertHuman, loadCommitted, viewOf, type CliContext } from "../context.js";
import { CliError } from "../io.js";

function cliError(e: unknown): CliError {
  if (e instanceof ActionError) return new CliError(e.message, e.status === 403 ? 2 : e.status === 409 ? 2 : 1, e.diagnostics);
  if (e instanceof CliError) return e;
  return new CliError((e as Error).message, 1);
}

export interface DeployResult {
  id: string;
  env: string;
  commit: string;
  status: string;
  sha: string;
  exitCode: number | null;
  output: string;
  view: ChangeView;
}

/**
 * `sdlc deploy <env> <CHG>` (3.6): a person deploys a change to an
 * environment. Production is the gate — the role check, the merged commit
 * and the rehearsed rollback are core's refusals — and the declared command
 * runs only after the decision is committed. Agents are refused before any of it.
 */
export async function deployCommand(ctx: CliContext, envName: string, id: string): Promise<DeployResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const store = new StateStore({ root: ctx.root, identity: who });
  try {
    const r = await deployEnvironment(store, id, envName, { env: ctx.io.env, ...(ctx.io.now ? { now: ctx.io.now } : {}) });
    const after = await loadCommitted(ctx);
    const d = r.deployment;
    return { id, env: envName, commit: r.commit, status: d.status, sha: d.sha, exitCode: d.exitCode ?? null, output: d.output, view: viewOf(after.repo, id) };
  } catch (e) {
    throw cliError(e);
  }
}

export interface RehearsalResult {
  id: string;
  env: string;
  commit: string;
  status: string;
  sha: string;
  exitCode: number;
  output: string;
  published: string[];
  view: ChangeView;
}

/** `sdlc rehearse-rollback <env> <CHG>` (3.6): run the environment's rollback command against what it has deployed and record the rehearsal — the production gate's evidence. */
export async function rehearseCommand(ctx: CliContext, envName: string, id: string): Promise<RehearsalResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const store = new StateStore({ root: ctx.root, identity: who });
  try {
    const r = await rehearseRollback(store, id, envName, { env: ctx.io.env, ...(ctx.io.now ? { now: ctx.io.now } : {}) });
    const after = await loadCommitted(ctx);
    return { id, env: envName, commit: r.commit, status: r.rehearsal.status, sha: r.rehearsal.sha, exitCode: r.rehearsal.exitCode, output: r.rehearsal.output, published: r.published, view: viewOf(after.repo, id) };
  } catch (e) {
    throw cliError(e);
  }
}

export interface ProductionGateResult {
  id: string | null;
  env: string | null;
  sha: string | null;
  verdict: "pass" | "fail" | "pending";
  summary: string;
  evidence: string | null;
  open: boolean;
  published: string[];
  /** Exit code: 0 green (or nothing to gate at this commit), 1 otherwise. */
  exitCode: 0 | 1;
}

/**
 * `sdlc production-gate [<CHG>] [--sha <sha>] [--publish]`: the gate's
 * required check from the committed records — what a CI job reads before a
 * team's own deploy workflow. `--sha` without a change finds the change merged
 * (or tested) at that commit; a commit no change records is nothing to gate.
 * `--publish` puts `sdlc/rollback-rehearsed` on the commit in GitHub mode. It
 * decides nothing: only `sdlc deploy <production env>` by the gate's owner does.
 */
export async function productionGateCommand(ctx: CliContext, id: string | undefined, opts: { sha?: string; publish?: boolean; ref?: string }): Promise<ProductionGateResult> {
  const { repo } = await loadCommitted(ctx, opts.ref ?? "HEAD");
  const production = productionEnvironment(repo.config);
  let view: ChangeView | null = null;
  if (id) view = viewOf(repo, id);
  else if (opts.sha) {
    for (const files of repo.changes.values()) {
      const v = deriveChange(repo, files);
      if (v.pr && (v.pr.mergeSha === opts.sha || v.pr.headSha === opts.sha)) {
        view = v;
        break;
      }
    }
    if (!view) return { id: null, env: production?.name ?? null, sha: opts.sha, verdict: "pending", summary: `no change records ${opts.sha.slice(0, 7)} as its merge commit or PR head — nothing to gate`, evidence: null, open: false, published: [], exitCode: 0 };
  } else throw new CliError("usage: sdlc production-gate <CHG> [--sha <sha>] [--publish]");
  if (opts.sha && view.pr && view.pr.mergeSha !== opts.sha && view.pr.headSha !== opts.sha) {
    return { id: view.id, env: production?.name ?? null, sha: opts.sha, verdict: "fail", summary: `${opts.sha.slice(0, 7)} is neither ${view.id}'s merge commit${view.pr.mergeSha ? ` (${view.pr.mergeSha.slice(0, 7)})` : ""} nor its PR head (${view.pr.headSha.slice(0, 7)})`, evidence: null, open: false, published: [], exitCode: 1 };
  }
  const verdict = check.productionGate(view);
  const gate = view.deploy.productionGate;
  const published: string[] = [];
  if (opts.publish && repo.config.codeHost !== "local" && gate?.sha) {
    const host = codeHostFor(repo.config.codeHost, ctx.io.env);
    const c = rollbackCheckFor(view, repo);
    for (const sha of [...new Set([gate.sha, view.pr?.headSha].filter((s): s is string => typeof s === "string"))]) {
      await host.publishCheck(ctx.root, sha, c, view.pr?.url);
      published.push(sha);
    }
  }
  return { id: view.id, env: gate?.env ?? production?.name ?? null, sha: gate?.sha ?? null, verdict: verdict.verdict, summary: verdict.summary, evidence: verdict.evidence, open: gate?.open ?? false, published, exitCode: verdict.allowed ? 0 : 1 };
}

export function renderProductionGate(r: ProductionGateResult): string {
  const head = `${r.id ?? "(no change)"} · production gate${r.env ? ` (${r.env})` : ""}${r.sha ? ` · ${r.sha.slice(0, 7)}` : ""} · ${r.open ? "open" : "closed"}`;
  const line = `sdlc/rollback-rehearsed: ${r.verdict} — ${r.summary}`;
  const evidence = r.evidence !== null ? `--- rehearsal output ---\n${r.evidence}` : "";
  const published = r.published.length > 0 ? `published on ${r.published.map((s) => s.slice(0, 7)).join(", ")}` : "";
  return [head, line, evidence, published].filter((l) => l !== "").join("\n");
}

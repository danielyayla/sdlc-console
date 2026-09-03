import { git, mergeIfUnmerged } from "@sdlc/adapter-git";
import { StateStore, acceptViaPr, artifactPrFor, codeHostFor, sendBackViaPr, ActionError } from "@sdlc/server";
import type { GitHubCodeHost } from "@sdlc/adapter-github";
import { accept, sendBack, type ChangeView } from "@sdlc/core";
import type { GateNumber } from "@sdlc/schemas";
import { actingIdentity, assertHuman, baseBranch, commitPlan, loadCommitted, transitionContext, viewOf, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface GateResult {
  id: string;
  gate: GateNumber;
  commit: string;
  mergeSha?: string;
  view: ChangeView;
}

function cliError(e: unknown): CliError {
  if (e instanceof ActionError) return new CliError(e.message, 2, e.diagnostics);
  return new CliError((e as Error).message, 2);
}

/** GitHub mode: when the gate's artifact is a pull request, gate actions go through it; returns the store to act with. */
async function githubArtifactPr(ctx: CliContext, codeHost: "local" | "github", who: { id: string; name: string }, id: string, gate: GateNumber): Promise<StateStore | null> {
  if (codeHost !== "github" || gate === 5) return null;
  const store = new StateStore({ root: ctx.root, identity: who });
  const snap = await store.refresh();
  const v = snap.changes.find((c) => c.id === id);
  return v && artifactPrFor(v, gate, snap.branches) ? store : null;
}

export function parseGate(raw: string | undefined): GateNumber {
  const n = Number(raw);
  if (![1, 2, 3, 5, 6].includes(n)) throw new CliError("--gate must be 1, 2, 3, 5 or 6");
  return n as GateNumber;
}

export async function acceptCommand(ctx: CliContext, id: string, gate: GateNumber): Promise<GateResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const view = viewOf(repo, id);
  const viaPr = await githubArtifactPr(ctx, repo.config.codeHost, who, id, gate);
  if (viaPr) {
    try {
      const host = codeHostFor("github", ctx.io.env) as GitHubCodeHost;
      const r = await acceptViaPr({ host, identity: who }, viaPr, id, gate);
      const after = await loadCommitted(ctx);
      return { id, gate, commit: r.commit, mergeSha: r.mergeSha, view: viewOf(after.repo, id) };
    } catch (e) {
      throw cliError(e);
    }
  }
  let mergeSha: string | undefined;
  let source: "cli" | "pr.merge" = "cli";
  if (gate === 5) {
    if (!view.gate || view.gate.s !== 5) throw new CliError(`${id} is not waiting at gate 5 (${view.status})`, 2);
    if (!view.pr) throw new CliError(`${id} has no pr.yaml`, 2);
    const base = await baseBranch(ctx, repo);
    const current = (await git(ctx.root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== base) throw new CliError(`gate 5 merges into ${base}; check it out first (currently on ${current})`, 2);
    try {
      const host = codeHostFor(repo.config.codeHost, ctx.io.env);
      mergeSha = await host.merge(ctx.root, view.pr, `sdlc(${id}): merge ${view.pr.branch} (gate 5)`, who);
      if (host.provider === "github") source = "pr.merge";
    } catch (e) {
      throw new CliError(`merge refused: ${(e as Error).message}`, 2);
    }
  }
  let merged: string | null = null;
  if (gate !== 5) {
    const artifact = { 1: "intent", 2: "spec", 3: "plan", 6: "incident" }[gate];
    const base = await baseBranch(ctx, repo);
    const current = (await git(ctx.root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === base) merged = await mergeIfUnmerged(ctx.root, `sdlc/${id}/${artifact}`, `sdlc(${id}): merge sdlc/${id}/${artifact} (gate ${gate})`, who);
  }
  const fresh = mergeSha || merged ? await loadCommitted(ctx) : { repo };
  const freshView = mergeSha || merged ? viewOf(fresh.repo, id) : view;
  const r = accept(fresh.repo, freshView, gate, transitionContext(who, { source, ...(mergeSha ? { mergeSha } : {}) }));
  if (!r.ok) throw new CliError(`accept refused`, 2, r.diagnostics);
  const commit = await commitPlan(ctx, fresh.repo, r.plan, who);
  const after = await loadCommitted(ctx);
  return { id, gate, commit, ...(mergeSha ? { mergeSha } : {}), view: viewOf(after.repo, id) };
}

export async function sendBackCommand(ctx: CliContext, id: string, gate: GateNumber, feedback: string): Promise<GateResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const view = viewOf(repo, id);
  const viaPr = await githubArtifactPr(ctx, repo.config.codeHost, who, id, gate);
  if (viaPr) {
    try {
      const host = codeHostFor("github", ctx.io.env) as GitHubCodeHost;
      const r = await sendBackViaPr({ host, identity: who }, viaPr, id, gate, feedback);
      const after = await loadCommitted(ctx);
      return { id, gate, commit: r.commit, view: viewOf(after.repo, id) };
    } catch (e) {
      throw cliError(e);
    }
  }
  const r = sendBack(repo, view, gate, feedback, transitionContext(who));
  if (!r.ok) throw new CliError(`send-back refused`, 2, r.diagnostics);
  const commit = await commitPlan(ctx, repo, r.plan, who);
  const after = await loadCommitted(ctx);
  return { id, gate, commit, view: viewOf(after.repo, id) };
}

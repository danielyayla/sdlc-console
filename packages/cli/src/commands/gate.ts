import { git, mergeIfUnmerged } from "@sdlc/adapter-git";
import { codeHostFor } from "@sdlc/server";
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
  const r = sendBack(repo, view, gate, feedback, transitionContext(who));
  if (!r.ok) throw new CliError(`send-back refused`, 2, r.diagnostics);
  const commit = await commitPlan(ctx, repo, r.plan, who);
  const after = await loadCommitted(ctx);
  return { id, gate, commit, view: viewOf(after.repo, id) };
}

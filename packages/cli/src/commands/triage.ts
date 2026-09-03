import { acceptTriage, dismissTriage } from "@sdlc/core";
import { actingIdentity, assertHuman, commitPlan, loadCommitted, transitionContext, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface TriageResult {
  id: string;
  commit: string;
  changeId: string | null;
}

export async function triageAcceptCommand(ctx: CliContext, id: string): Promise<TriageResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const r = acceptTriage(repo, id, transitionContext(who));
  if (!r.ok) throw new CliError("triage accept refused", 2, r.diagnostics);
  const commit = await commitPlan(ctx, repo, r.plan, who);
  return { id, commit, changeId: r.plan.changeId };
}

export async function triageDismissCommand(ctx: CliContext, id: string, reason: string, tune?: string): Promise<TriageResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const r = dismissTriage(repo, id, reason, transitionContext(who), tune);
  if (!r.ok) throw new CliError("triage dismiss refused", 2, r.diagnostics);
  const commit = await commitPlan(ctx, repo, r.plan, who);
  return { id, commit, changeId: null };
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dismissFinding, escalateFinding, importFindings, patchFinding } from "@sdlc/core";
import { parseFindingsImport } from "@sdlc/schemas";
import { actingIdentity, assertHuman, commitPlan, loadCommitted, transitionContext, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface SecurityResult {
  id: string;
  action: "patch" | "escalate" | "dismiss" | "import";
  commit: string;
  changeId: string | null;
  imported?: number;
}

export async function securityCommand(ctx: CliContext, action: "patch" | "escalate" | "dismiss", id: string, reason?: string): Promise<SecurityResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const t = transitionContext(who);
  const r = action === "patch" ? patchFinding(repo, id, t) : action === "escalate" ? escalateFinding(repo, id, t) : dismissFinding(repo, id, reason ?? "", t);
  if (!r.ok) throw new CliError(`security ${action} refused`, 2, r.diagnostics);
  const commit = await commitPlan(ctx, repo, r.plan, who);
  return { id, action, commit, changeId: r.plan.changeId };
}

/** `sdlc security import <file>`: CSV or Markdown table from the scanner. */
export async function securityImportCommand(ctx: CliContext, file: string): Promise<SecurityResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const text = file === "-" ? await ctx.io.stdin() : readFileSync(resolve(ctx.io.cwd, file), "utf8");
  const parsed = parseFindingsImport(text, file);
  if (!parsed.ok || !parsed.value) throw new CliError("import failed", 1, parsed.diagnostics);
  const { repo } = await loadCommitted(ctx);
  const r = importFindings(repo, parsed.value, transitionContext(who));
  if (!r.ok) throw new CliError("security import refused", 2, r.diagnostics);
  const commit = await commitPlan(ctx, repo, r.plan, who);
  return { id: file, action: "import", commit, changeId: null, imported: parsed.value.length };
}

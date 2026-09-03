import { changeIdsByRef } from "@sdlc/adapter-git";
import { validateIds, validateTree, type RuleDiagnostic } from "@sdlc/core";
import { loadCommitted, loadWorking, type CliContext } from "../context.js";

export interface ValidateOptions {
  ref?: string;
  working?: boolean;
}

export interface ValidateResult {
  ref: string;
  blocking: boolean;
  diagnostics: RuleDiagnostic[];
}

export async function validateCommand(ctx: CliContext, opts: ValidateOptions): Promise<ValidateResult> {
  const loaded = opts.working ? loadWorking(ctx) : await loadCommitted(ctx, opts.ref ?? "HEAD");
  const tree = validateTree(loaded.repo);
  const ids = validateIds(await changeIdsByRef(ctx.root));
  const diagnostics = [...tree.diagnostics, ...ids.diagnostics];
  return { ref: opts.working ? "working tree" : (loaded.tree.ref ?? opts.ref ?? "HEAD"), blocking: diagnostics.some((d) => d.blocking), diagnostics };
}

export function formatDiagnostic(d: RuleDiagnostic): string {
  const where = d.line ? `${d.path}:${d.line}` : d.path;
  const sev = d.blocking ? "BLOCK" : d.severity === "error" ? "error" : "warn ";
  return `${sev}  ${where}${d.pointer && d.pointer !== "/" ? ` ${d.pointer}` : ""}  ${d.message}  [${d.rule}]`;
}

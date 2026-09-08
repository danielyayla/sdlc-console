import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { identity as gitIdentity, ledgerCommits } from "@sdlc/adapter-git";
import { exportChange, renderChangeExportMarkdown } from "@sdlc/core";
import type { ChangeExport } from "@sdlc/schemas";
import { loadCommitted, viewOf, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface ExportOptions {
  format: "json" | "md";
  ref?: string;
  /** Write the document here instead of stdout. */
  out?: string;
  now?: () => Date;
}

export interface ExportResult {
  doc: ChangeExport;
  /** The serialized document in the requested format. */
  text: string;
  /** Absolute path written, when `--out` was given. */
  out: string | null;
}

/**
 * `sdlc export <CHG>`: the compliance export derived in core from the tree at
 * `ref`, with the commit carrying each gate decision resolved from the
 * ledger's history. JSON is the canonical, hashed form; Markdown renders it.
 * Read-only, so it needs no role and refuses nobody.
 */
export async function exportCommand(ctx: CliContext, id: string, opts: ExportOptions): Promise<ExportResult> {
  const ref = opts.ref ?? "HEAD";
  const { repo } = await loadCommitted(ctx, ref);
  const view = viewOf(repo, id);
  const commits = await ledgerCommits(ctx.root, id, ref);
  const override = ctx.io.env["SDLC_IDENTITY"]?.trim();
  const who = override ? { id: override } : ((await gitIdentity(ctx.root)) ?? { id: ctx.io.env["USER"] ?? "unknown" });
  const exportedAt = (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const doc = exportChange(repo, view, { exportedAt, exportedBy: { id: who.id, ...("name" in who && who.name ? { name: who.name } : {}) }, commits });
  if (!doc) throw new CliError(`${id} not found under sdlc/changes/`);
  const text = opts.format === "md" ? renderChangeExportMarkdown(doc) : `${JSON.stringify(doc, null, 2)}\n`;
  let out: string | null = null;
  if (opts.out) {
    out = resolve(ctx.io.cwd, opts.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text, "utf8");
  }
  return { doc, text, out };
}

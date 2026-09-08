import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_IDENTITY } from "@sdlc/adapter-git";
import { ingestChannelDelivery, ingestSecurityDelivery } from "@sdlc/core";
import { validate, type ClaudeSecurityDelivery, type ClaudeTagDelivery } from "@sdlc/schemas";
import { actingIdentity, assertHuman, commitPlan, loadCommitted, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface IngestResult {
  kind: "security" | "channel";
  file: string;
  /** null when nothing changed (every finding already on file, or the message already has an item). */
  commit: string | null;
  outcome: string;
  created: string[];
  updated: string[];
  resolved: string[];
  /** The triage item for a channel message: the new one, or the one that already held it. */
  id: string | null;
}

function readEnvelope(ctx: CliContext, file: string): Promise<string> {
  return file === "-" ? ctx.io.stdin() : Promise.resolve(readFileSync(resolve(ctx.io.cwd, file), "utf8"));
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${file}: invalid JSON — ${(e as Error).message}`);
  }
}

/**
 * `sdlc ingest security|channel <file.json|->` (3.5): the same envelope the
 * webhooks accept, the same core transform, committed here by sdlc-bot with
 * the invoking person as `SDLC-Relay`. Human CLI only — an agent process is
 * refused, and there is no MCP tool for this: agents do not fabricate
 * findings or triage items.
 */
export async function ingestCommand(ctx: CliContext, kind: "security" | "channel", file: string): Promise<IngestResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const raw = parseJson(await readEnvelope(ctx, file), file);
  const now = (ctx.io.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const { repo } = await loadCommitted(ctx);
  if (kind === "security") {
    const checked = validate("claude-security-delivery", raw, file);
    if (!checked.ok) throw new CliError(`${file} is not a claude-security-delivery envelope (schema 1)`, 1, checked.diagnostics);
    const d: ClaudeSecurityDelivery = checked.value;
    const r = ingestSecurityDelivery(repo, d, { now });
    const i = r.ingest ?? { created: [], updated: [], resolved: [], unchanged: [], unknownResolved: [] };
    if (!r.ok) return { kind, file, commit: null, outcome: r.diagnostics[0]?.message ?? "nothing new", created: [], updated: [], resolved: [], id: null };
    r.plan.trailers["SDLC-Relay"] = `human:${who.id}`;
    const commit = await commitPlan(ctx, repo, r.plan, SYSTEM_IDENTITY);
    return { kind, file, commit, outcome: `${i.created.length} new, ${i.updated.length} updated, ${i.resolved.length} resolved`, created: i.created, updated: i.updated, resolved: i.resolved, id: null };
  }
  const checked = validate("claude-tag-delivery", raw, file);
  if (!checked.ok) throw new CliError(`${file} is not a claude-tag-delivery envelope (schema 1)`, 1, checked.diagnostics);
  const d: ClaudeTagDelivery = checked.value;
  const r = ingestChannelDelivery(repo, d, { now });
  if (!r.ok) return { kind, file, commit: null, outcome: r.diagnostics[0]?.message ?? "duplicate", created: [], updated: [], resolved: [], id: r.duplicateOf ?? null };
  r.plan.trailers["SDLC-Relay"] = `human:${who.id}`;
  const commit = await commitPlan(ctx, repo, r.plan, SYSTEM_IDENTITY);
  return { kind, file, commit, outcome: `${r.id ?? ""} raised`, created: r.id ? [r.id] : [], updated: [], resolved: [], id: r.id ?? null };
}

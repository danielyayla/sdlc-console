import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changeIdsByRef } from "@sdlc/adapter-git";
import { createChange, deriveAll, type ChangeView, type CreateChangeInput } from "@sdlc/core";
import { actingIdentity, assertHuman, commitPlan, loadCommitted, transitionContext, viewOf, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface NewChangeOptions {
  title: string;
  kind: "feature" | "fix";
  risk: "routine" | "high";
  origin: string;
  /** Path to an intent body, or `-` for stdin. */
  intent?: string;
}

export interface NewChangeResult {
  id: string;
  commit: string;
  view: ChangeView;
}

export async function changeNew(ctx: CliContext, opts: NewChangeOptions): Promise<NewChangeResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  const [type, ...refParts] = opts.origin.split(":");
  const originType = type as CreateChangeInput["origin"]["type"];
  if (!["idea", "ticket", "triage", "security", "incident", "channel"].includes(originType)) {
    throw new CliError(`--origin must be one of idea|ticket|triage|security|incident|channel, optionally with :ref`);
  }
  let intentBody: string | undefined;
  if (opts.intent === "-") intentBody = await ctx.io.stdin();
  else if (opts.intent) intentBody = readFileSync(resolve(ctx.io.cwd, opts.intent), "utf8");
  const ref = refParts.join(":");
  const idsByRef = await changeIdsByRef(ctx.root);
  const r = createChange(
    repo,
    {
      title: opts.title,
      kind: opts.kind,
      risk: opts.risk,
      origin: ref ? { type: originType, ref } : { type: originType },
      ...(intentBody !== undefined ? { intentBody } : {}),
    },
    transitionContext(who, { knownIds: Object.values(idsByRef).flat() }),
  );
  if (!r.ok) throw new CliError("change new refused", 2, r.diagnostics);
  const id = r.plan.changeId;
  if (!id) throw new CliError("createChange produced no change id");
  const commit = await commitPlan(ctx, repo, r.plan, who);
  const after = await loadCommitted(ctx);
  return { id, commit, view: viewOf(after.repo, id) };
}

export interface ListOptions {
  stage?: number;
  ref?: string;
}

export async function changeList(ctx: CliContext, opts: ListOptions): Promise<ChangeView[]> {
  const { repo } = await loadCommitted(ctx, opts.ref ?? "HEAD");
  const all = deriveAll(repo).changes;
  return opts.stage ? all.filter((c) => c.stage === opts.stage) : all;
}

export async function changeShow(ctx: CliContext, id: string, ref = "HEAD"): Promise<ChangeView> {
  const { repo } = await loadCommitted(ctx, ref);
  return viewOf(repo, id);
}

export function summarize(v: ChangeView): string[] {
  return [
    v.id,
    `${v.stage}·${v.stageName}`,
    v.gate ? `gate ${v.gate.s} → ${v.gate.ownerRole}` : "—",
    v.agent ? "⌁" : " ",
    v.risk === "high" ? "high" : "routine",
    v.valid ? v.status : `INVALID (${v.validationErrors.length})`,
  ];
}

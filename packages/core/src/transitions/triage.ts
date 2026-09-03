import { stringifyFrontMatter, type Triage } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { Repo, TriageFile } from "../repo.js";
import { refuse, type TransitionResult } from "../writeplan.js";
import { createChange } from "./create-change.js";
import type { TransitionContext } from "./context.js";

function findTriage(repo: Repo, id: string): TriageFile | null {
  return repo.triage.find((t) => t.data.id === id) ?? null;
}

function requirePo(repo: Repo, ctx: TransitionContext): TransitionResult | null {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "po") && !holdsRole(repo.config, ctx.actor.id, "service_owner")) {
    return refuse("triage.not-owner", `${ctx.actor.id} holds neither po nor service_owner`);
  }
  return null;
}

/**
 * Accept → Plan (FR-61, acceptance c): a new change at stage 1 whose intent is
 * the triage item's pre-drafted body; the item leaves the queue in the same
 * commit and the change's `origin` keeps the link.
 */
export function acceptTriage(repo: Repo, triageId: string, ctx: TransitionContext): TransitionResult {
  const denied = requirePo(repo, ctx);
  if (denied) return denied;
  const item = findTriage(repo, triageId);
  if (!item) return refuse("triage.missing", `${triageId} is not in the queue`);
  if (item.data.status !== "open") return refuse("triage.not-open", `${triageId} is ${item.data.status}`);
  const created = createChange(
    repo,
    {
      title: item.data.title,
      kind: item.data.tier === "incident" ? "fix" : "feature",
      risk: "routine",
      origin: { type: "triage", ref: triageId },
      intentBody: item.body.trim() === "" ? undefined : item.body,
    } as Parameters<typeof createChange>[1],
    ctx,
  );
  if (!created.ok) return created;
  const plan = created.plan;
  plan.files.push({ path: item.path, content: null });
  plan.commitMessage = `sdlc(${plan.changeId ?? ""}): accept ${triageId} → intent.md`;
  return { ok: true, plan };
}

/** Dismiss with a reason (and an optional band-tune note); the file stays as history. */
export function dismissTriage(repo: Repo, triageId: string, reason: string, ctx: TransitionContext, bandTune?: string): TransitionResult {
  const denied = requirePo(repo, ctx);
  if (denied) return denied;
  if (reason.trim() === "") return refuse("dismissal.reason-missing", "a dismissal needs a reason");
  const item = findTriage(repo, triageId);
  if (!item) return refuse("triage.missing", `${triageId} is not in the queue`);
  if (item.data.status !== "open") return refuse("triage.not-open", `${triageId} is ${item.data.status}`);
  const data: Triage = {
    ...item.data,
    status: "dismissed",
    dismissal: { by: ctx.actor.id, reason: reason.trim(), at: ctx.now, ...(bandTune ? { bandTune } : {}) },
  };
  return {
    ok: true,
    plan: {
      changeId: null,
      files: [{ path: item.path, content: stringifyFrontMatter(data as unknown as Record<string, unknown>, item.body) }],
      events: [],
      commitMessage: `sdlc(${triageId}): dismiss — ${reason.trim()}`,
      trailers: { "SDLC-Actor": `human:${ctx.actor.id}` },
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

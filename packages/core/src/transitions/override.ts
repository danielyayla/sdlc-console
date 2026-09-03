import type { SessionMode } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import { isDowngrade } from "../modes.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, trailersFor, type TransitionContext } from "./context.js";

export interface OverrideInput {
  session: string;
  from: SessionMode;
  to: SessionMode;
  reason?: string | undefined;
}

/**
 * AUTO → SUPERVISED (FR-22, FR-34): an engineer takes autonomy away from a
 * session and the ledger says so. Never upward — eligibility is derived, the
 * override only reduces it. The adapter ends the harness and hands the
 * engineer the resume command; this records the decision.
 */
export function overrideMode(repo: Repo, view: ChangeView, input: OverrideInput, ctx: TransitionContext): TransitionResult {
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (view.closed) return refuse("change.closed", `${view.id} is closed`);
  if (!isDowngrade(input.from, input.to)) return refuse("override.upward", `${input.from} → ${input.to} is not a downgrade; autonomy is derived and can only be reduced`);
  if (repo.config.present && !holdsRole(repo.config, ctx.actor.id, "eng")) return refuse("override.not-engineer", `${ctx.actor.id} does not hold the engineer role`);
  const ev = new EventBuilder(ctx, files, view.id);
  const reason = input.reason?.trim();
  const event = ev.human("override.mode", "eng", files.change.cycle, { from: input.from, to: input.to, ...(reason ? { reason } : {}) });
  const plan: WritePlan = {
    changeId: view.id,
    files: [],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): session ${input.session} ${input.from} → ${input.to}${reason ? ` (${reason})` : ""}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: "eng" },
  };
  return { ok: true, plan };
}

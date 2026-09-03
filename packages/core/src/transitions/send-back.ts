import type { GateNumber } from "@sdlc/schemas";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { ARTIFACT_INDEX_FOR_GATE } from "../stages.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { checkGate, EventBuilder, trailersFor, type TransitionContext } from "./context.js";

/** Send an artifact back with feedback (FR-13/FR-21): stage unchanged, agent revises. */
export function sendBack(repo: Repo, view: ChangeView, gate: GateNumber, feedback: string, ctx: TransitionContext): TransitionResult {
  if (feedback.trim() === "") return refuse("send-back.feedback.empty", "send-back needs feedback");
  const check = checkGate(repo, view, gate, ctx);
  if (!check.ok) return check.result;
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("gate.sent_back", check.role, files.change.cycle, { gate, feedback: feedback.trim() });
  const doc = view.docs[ARTIFACT_INDEX_FOR_GATE[gate]];
  const plan: WritePlan = {
    changeId: view.id,
    files: [],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): send back ${doc.name} (gate ${gate})`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: check.role },
  };
  return { ok: true, plan };
}

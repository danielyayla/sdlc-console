import { stringifyYaml, type Proposal } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult } from "../writeplan.js";
import type { TransitionContext } from "./context.js";

/** Dismiss a CLAUDE.md / test-change proposal with a reason (FR-22, FR-43). Accepting opens a PR on the code host (Phase 2). */
export function dismissProposal(repo: Repo, id: string, reason: string, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng") && !holdsRole(repo.config, ctx.actor.id, "platform")) {
    return refuse("proposal.not-owner", `${ctx.actor.id} holds neither eng nor platform`);
  }
  if (reason.trim() === "") return refuse("dismissal.reason-missing", "a dismissal needs a reason");
  const p = repo.proposals.find((x) => x.id === id);
  if (!p) return refuse("proposal.missing", `${id} not found`);
  if (p.status !== "open") return refuse("proposal.not-open", `${id} is ${p.status}`);
  const next: Proposal = { ...p, status: "dismissed", dismissal: { by: ctx.actor.id, reason: reason.trim(), at: ctx.now } };
  return {
    ok: true,
    plan: {
      changeId: null,
      files: [{ path: `sdlc/proposals/${id}.yaml`, content: stringifyYaml(next) }],
      events: [],
      commitMessage: `sdlc(${id}): dismiss — ${reason.trim()}`,
      trailers: { "SDLC-Actor": `human:${ctx.actor.id}` },
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

import type { Event, EventName, EventOf, GateNumber } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import type { ChangeFiles, Repo } from "../repo.js";
import { gateOwner, ROLE_LABELS, type GateRole } from "../stages.js";
import { syntheticSha } from "../tree.js";
import type { TransitionResult } from "../writeplan.js";
import { refuse } from "../writeplan.js";

/** A person acting through console or CLI. Agents never get a TransitionContext. */
export interface HumanIdentity {
  id: string;
  /** Display name, for commit authorship; the adapter may ignore it. */
  name?: string;
}

export interface TransitionContext {
  /** ISO timestamp for every event and front-matter field written by this transition. */
  now: string;
  /** ULID factory; injected so core stays free of randomness and clocks. */
  newId: () => string;
  actor: HumanIdentity;
  /** Merge commit sha, required by gate 5 (the adapter merges first: locally, or through the code host API). */
  mergeSha?: string;
  /**
   * How the decision reached the console. `pr.merge` means the code host
   * merged under branch protection (GitHub mode); it is the only source that
   * satisfies a gate whose mode is `via_branch_protection` or `via_pr`.
   */
  source?: "cli" | "console" | "pr.merge";
  /** Extra ids known from other branches, for allocation (docs/storage-layout.md). */
  knownIds?: Iterable<string>;
  /** Blob sha for content about to be written; the git adapter passes git's hash-object. Synthetic by default. */
  blobSha?: (content: string) => string;
}

export function blobShaOf(ctx: TransitionContext, content: string): string {
  return (ctx.blobSha ?? syntheticSha)(content);
}

export const SYSTEM_ACTOR = { type: "system", id: "sdlc-bot" } as const;

export class EventBuilder {
  private seq: number;
  constructor(
    private readonly ctx: TransitionContext,
    files: ChangeFiles | null,
    private readonly changeId: string,
  ) {
    this.seq = files ? Math.max(0, ...files.events.map((e) => e.seq)) : 0;
  }

  private base(cycle: number, actor: Event["actor"]) {
    this.seq += 1;
    return { schema: 1 as const, id: this.ctx.newId(), ts: this.ctx.now, seq: this.seq, cycle, actor };
  }

  human<N extends EventName>(name: N, role: string | null, cycle: number, data: EventOf<N>["data"]): Event {
    const actor = role ? { type: "human" as const, id: this.ctx.actor.id, role } : { type: "human" as const, id: this.ctx.actor.id };
    return { ...this.base(cycle, actor), event: name, data } as unknown as Event;
  }

  system<N extends EventName>(name: N, cycle: number, data: EventOf<N>["data"]): Event {
    return { ...this.base(cycle, SYSTEM_ACTOR), event: name, data } as unknown as Event;
  }

  write(event: Event) {
    return { changeId: this.changeId, event };
  }
}

export function trailersFor(events: readonly Event[], actor: HumanIdentity): Record<string, string> {
  const first = events[0];
  return {
    ...(first ? { "SDLC-Event": first.id } : {}),
    "SDLC-Actor": `human:${actor.id}`,
  };
}

/** Common preconditions for gate actions. Returns a refusal or the owner role. */
export function checkGate(
  repo: Repo,
  view: ChangeView,
  gate: GateNumber,
  ctx: TransitionContext,
): { ok: true; role: GateRole } | { ok: false; result: TransitionResult } {
  const fail = (rule: string, message: string) => ({ ok: false as const, result: refuse(rule, message, `sdlc/changes/${view.id}`) });
  if (!repo.config.present) return fail("config.missing", "sdlc/config.yaml is missing — gate ownership cannot be verified");
  if (!view.valid) return fail("change.invalid", `${view.id} has validation errors; fix them before acting on a gate`);
  if (view.closed) return fail("change.closed", `${view.id} is closed`);
  if (!view.gate) return fail("gate.closed", `${view.id} has no open gate (stage ${view.stage}: ${view.status})`);
  if (view.gate.s !== gate) return fail("gate.mismatch", `${view.id} is waiting at gate ${view.gate.s}, not gate ${gate}`);
  const owner = gateOwner(gate, view.risk, repo.config.codeHost === "github" ? "github" : "local");
  const viaCodeHost = ctx.source === "pr.merge";
  if (owner.mode === "via_branch_protection" && !viaCodeHost) return fail("gate.via-code-host", "this gate is accepted by merging the PR on the code host");
  if (owner.mode === "via_pr" && repo.config.codeHost === "github" && !viaCodeHost) return fail("gate.via-pr", "high-risk plans are accepted by merging the plan PR");
  if (!holdsRole(repo.config, ctx.actor.id, owner.role)) {
    return fail("gate.not-owner", `${ctx.actor.id} does not hold the ${ROLE_LABELS[owner.role]} role that owns gate ${gate}`);
  }
  return { ok: true, role: owner.role };
}

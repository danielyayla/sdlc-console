import { stringifyJson, stringifyYaml, type Change, type ReproProof } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, trailersFor, type TransitionContext } from "./context.js";

export interface ReproInput {
  testPath: string;
  failureReason: string;
  /** Commit that contains the failing test alone. */
  sha: string;
  /** Verbatim failing output. */
  output: string;
}

/** Engineer confirms the repro test "fails for the right reason" (FR-51); freeze begins. */
export function confirmRepro(repo: Repo, view: ChangeView, input: ReproInput, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng")) return refuse("repro.not-engineer", `${ctx.actor.id} does not hold the engineer role`);
  if (!view.valid) return refuse("change.invalid", `${view.id} has validation errors`);
  if (view.kind !== "fix") return refuse("repro.not-fix", `${view.id} is a ${view.kind} change; repro applies to fixes`);
  if (view.stage !== 4) return refuse("repro.stage", `repro is confirmed during Build/Test (stage 4); ${view.id} is at stage ${view.stage}`);
  if (view.repro?.state === "committed") return refuse("repro.already", "repro test already committed");
  if (!/^[0-9a-f]{40}$/.test(input.sha)) return refuse("repro.sha", "repro needs the sha of the commit containing the failing test");
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const change: Change = {
    ...files.change,
    repro: { state: "committed", testPath: input.testPath, failureReason: input.failureReason, sha: input.sha },
  };
  const proof: ReproProof = {
    schema: 1,
    testPath: input.testPath,
    failureReason: input.failureReason,
    sha: input.sha,
    output: input.output,
    confirmedBy: ctx.actor.id,
    confirmedAt: ctx.now,
  };
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("repro.confirmed", "eng", files.change.cycle, { testPath: input.testPath, sha: input.sha });
  const plan: WritePlan = {
    changeId: view.id,
    files: [
      { path: `${files.dir}/change.yaml`, content: stringifyYaml(change) },
      { path: `${files.dir}/evals/repro.json`, content: stringifyJson(proof) },
    ],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): confirm repro test ${input.testPath}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: "eng" },
  };
  return { ok: true, plan };
}

import { stringifyJson, stringifyYaml, type Change, type Pr, type ReproProof } from "@sdlc/schemas";
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

export interface RejectInput {
  testPath: string;
  reason: string;
}

/** "Wrong failure — send back" (spec 5B.3): the engineer's judgment goes on the ledger; the session rewrites the repro test. */
export function rejectRepro(repo: Repo, view: ChangeView, input: RejectInput, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng")) return refuse("repro.not-engineer", `${ctx.actor.id} does not hold the engineer role`);
  if (view.kind !== "fix") return refuse("repro.not-fix", `${view.id} is a ${view.kind} change; repro applies to fixes`);
  if (view.stage !== 4) return refuse("repro.stage", `repro is judged during Build/Test (stage 4); ${view.id} is at stage ${view.stage}`);
  if (view.repro?.state === "committed") return refuse("repro.already", "repro test already committed; the freeze is active");
  const reason = input.reason.trim();
  if (reason === "") return refuse("repro.reason-missing", "sending a repro test back needs a reason");
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("repro.rejected", "eng", files.change.cycle, { testPath: input.testPath, reason });
  const plan: WritePlan = {
    changeId: view.id,
    files: [],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): repro test ${input.testPath} sent back — ${reason}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: "eng" },
  };
  return { ok: true, plan };
}

export interface LiftInput {
  path: string;
  reason: string;
}

/** Engineer lifts the test freeze for one file, once per change (FR-22, FR-51); the hook honours it from the ledger. */
export function liftFreeze(repo: Repo, view: ChangeView, input: LiftInput, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng")) return refuse("freeze.not-engineer", `${ctx.actor.id} does not hold the engineer role`);
  if (view.repro?.state !== "committed" || (view.stage !== 3 && view.stage !== 4)) return refuse("freeze.not-active", `no test freeze is active on ${view.id} (repro ${view.repro?.state ?? "none"}, stage ${view.stage})`);
  const path = input.path.trim();
  if (path === "") return refuse("freeze.path-missing", "a lift names one file");
  const reason = input.reason.trim();
  if (reason === "") return refuse("freeze.reason-missing", "lifting the freeze needs a reason");
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (view.freezeLifts.some((l) => l.path === path)) return refuse("freeze.already-lifted", `the freeze on ${path} was already lifted once for ${view.id}; edit the file yourself`);
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("freeze.lifted", "eng", files.change.cycle, { path, reason });
  const plan: WritePlan = {
    changeId: view.id,
    files: [],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): lift test freeze once for ${path}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: "eng" },
  };
  return { ok: true, plan };
}

export interface DismissAutoFindingInput {
  path: string;
  reason: string;
}

/** The code owner dismisses a system-raised PR finding with a reason; the merge unblocks and the ledger keeps the note. */
export function dismissAutoFinding(repo: Repo, view: ChangeView, input: DismissAutoFindingInput, ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng")) return refuse("finding.not-engineer", `${ctx.actor.id} does not hold the engineer role`);
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (!files.pr) return refuse("pr.missing", `${view.id} has no pull request`);
  if (files.pr.mergedAt !== undefined) return refuse("pr.merged", `${view.id}'s PR is already merged`);
  const reason = input.reason.trim();
  if (reason === "") return refuse("dismissal.reason-missing", "a dismissal needs a reason");
  const open = (files.pr.autoFindings ?? []).findIndex((f) => f.path === input.path && !f.dismissal);
  if (open < 0) return refuse("finding.missing", `no open auto-finding on ${input.path}`);
  const autoFindings = (files.pr.autoFindings ?? []).map((f, i) => (i === open ? { ...f, dismissal: { by: ctx.actor.id, reason, at: ctx.now } } : f));
  const target = autoFindings[open];
  const pr: Pr = { ...files.pr, autoFindings };
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("note", "eng", files.change.cycle, { text: `dismissed auto-finding "${target?.title ?? ""}" on ${input.path}: ${reason}` });
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path: `${files.dir}/pr.yaml`, content: stringifyYaml(pr) }],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): dismiss auto-finding on ${input.path} — ${reason}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: "eng" },
  };
  return { ok: true, plan };
}

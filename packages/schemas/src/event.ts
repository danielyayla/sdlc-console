import { z } from "zod";
import {
  actor,
  artifactIndex,
  changeId,
  cycleNumber,
  gateNumber,
  gitSha,
  humanActor,
  isoTimestamp,
  nonEmpty,
  relPath,
  schemaVersion,
  sessionMode,
  severity,
  stageNumber,
  systemActor,
  taskId,
  ulid,
} from "./common.js";

const base = {
  schema: schemaVersion,
  id: ulid,
  ts: isoTimestamp,
  seq: z.number().int().min(1),
  cycle: cycleNumber,
  sha: gitSha.optional(),
};

const ev = <N extends string, D extends z.ZodType, A extends z.ZodType>(
  name: N,
  data: D,
  who: A,
) => z.strictObject({ ...base, actor: who, event: z.literal(name), data });

export const roundResult = z.strictObject({
  name: nonEmpty,
  pass: z.boolean(),
  exitCode: z.number().int().optional(),
  outputExcerpt: z.string(),
});

export const proposedTask = z.strictObject({
  id: taskId,
  title: nonEmpty,
  files: z.array(relPath),
  sequential: z.boolean(),
});

/**
 * `log.jsonl` event union. Two invariants live in the schema itself, so Ajv
 * rejects them before any rule engine runs: `gate.accepted` must be authored by
 * a human, and `stage.entered` by the system.
 */
export const events = {
  "artifact.committed": ev(
    "artifact.committed",
    z.strictObject({ artifact: artifactIndex, path: relPath, sha: gitSha }),
    actor,
  ),
  "gate.accepted": ev(
    "gate.accepted",
    z.strictObject({
      gate: gateNumber,
      artifactSha: gitSha,
      source: z.enum(["cli", "console", "pr.merge"]),
      note: z.string().optional(),
    }),
    humanActor,
  ),
  "gate.sent_back": ev(
    "gate.sent_back",
    z.strictObject({ gate: gateNumber, feedback: nonEmpty }),
    humanActor,
  ),
  "stage.entered": ev("stage.entered", z.strictObject({ stage: stageNumber }), systemActor),
  "plan.drafted": ev("plan.drafted", z.strictObject({ rev: z.number().int().min(1) }), actor),
  "plan.final": ev("plan.final", z.strictObject({ rev: z.number().int().min(1) }), actor),
  question: ev(
    "question",
    z.strictObject({ text: nonEmpty, answer: z.string().optional() }),
    actor,
  ),
  "tasks.proposed": ev("tasks.proposed", z.strictObject({ tasks: z.array(proposedTask) }), actor),
  "tasks.confirmed": ev(
    "tasks.confirmed",
    z.strictObject({ taskIds: z.array(taskId).min(1) }),
    humanActor,
  ),
  "session.started": ev(
    "session.started",
    z.strictObject({
      session: nonEmpty,
      mode: sessionMode,
      task: taskId.optional(),
      worktree: z.string().optional(),
      target: z.string().optional(),
    }),
    actor,
  ),
  "session.stopped": ev(
    "session.stopped",
    z.strictObject({
      session: nonEmpty,
      reason: z.enum(["done", "stopped", "stalled", "error", "taken_over"]),
    }),
    actor,
  ),
  round: ev(
    "round",
    z.strictObject({
      n: z.number().int().min(1),
      results: z.array(roundResult).min(1),
      screenshotRef: z.string().optional(),
      diffPct: z.number().min(0).max(100).optional(),
    }),
    actor,
  ),
  "hook.blocked": ev(
    "hook.blocked",
    z.strictObject({ hook: nonEmpty, reason: nonEmpty, path: z.string().optional() }),
    actor,
  ),
  "hook.allowed": ev(
    "hook.allowed",
    z.strictObject({ hook: nonEmpty, path: z.string().optional() }),
    actor,
  ),
  "verifier.result": ev(
    "verifier.result",
    z.strictObject({ ran: z.boolean(), saw: z.boolean(), mismatch: z.boolean() }),
    actor,
  ),
  "repro.failed": ev(
    "repro.failed",
    z.strictObject({ testPath: relPath, failureReason: nonEmpty }),
    actor,
  ),
  "repro.confirmed": ev(
    "repro.confirmed",
    z.strictObject({ testPath: relPath, sha: gitSha }),
    humanActor,
  ),
  "freeze.lifted": ev("freeze.lifted", z.strictObject({ path: relPath, reason: nonEmpty }), humanActor),
  "evals.green": ev(
    "evals.green",
    z.strictObject({ run: nonEmpty, passed: z.number().int().min(0), total: z.number().int().min(0) }),
    actor,
  ),
  "evals.red": ev(
    "evals.red",
    z.strictObject({ run: nonEmpty, passed: z.number().int().min(0), total: z.number().int().min(0) }),
    actor,
  ),
  "pr.opened": ev(
    "pr.opened",
    z.strictObject({ number: z.number().int().min(1).optional(), url: z.string().optional(), headSha: gitSha }),
    actor,
  ),
  "pr.merged": ev(
    "pr.merged",
    z.strictObject({ number: z.number().int().min(1).optional(), mergeSha: gitSha }),
    actor,
  ),
  "review.finding": ev(
    "review.finding",
    z.strictObject({ severity, title: nonEmpty, path: z.string().optional() }),
    actor,
  ),
  "deploy.authorized": ev(
    "deploy.authorized",
    z.strictObject({ env: nonEmpty, version: z.string().optional() }),
    humanActor,
  ),
  "deploy.started": ev(
    "deploy.started",
    z.strictObject({ env: nonEmpty, version: z.string().optional() }),
    actor,
  ),
  "deploy.finished": ev(
    "deploy.finished",
    z.strictObject({ env: nonEmpty, version: z.string().optional() }),
    actor,
  ),
  "deploy.failed": ev(
    "deploy.failed",
    z.strictObject({ env: nonEmpty, reason: z.string().optional() }),
    actor,
  ),
  "record.writeback.ok": ev(
    "record.writeback.ok",
    z.strictObject({ system: nonEmpty, id: nonEmpty }),
    actor,
  ),
  "record.writeback.failed": ev(
    "record.writeback.failed",
    z.strictObject({ system: nonEmpty, id: nonEmpty, error: nonEmpty }),
    actor,
  ),
  "override.mode": ev(
    "override.mode",
    z.strictObject({ from: sessionMode, to: sessionMode, reason: z.string().optional() }),
    humanActor,
  ),
  "consult.tech_lead": ev(
    "consult.tech_lead",
    z.strictObject({ by: nonEmpty, note: z.string().optional() }),
    humanActor,
  ),
  note: ev("note", z.strictObject({ text: nonEmpty }), actor),
  "change.created": ev(
    "change.created",
    z.strictObject({ origin: z.string().optional(), from: changeId.optional() }),
    actor,
  ),
  "change.closed": ev("change.closed", z.strictObject({ reason: nonEmpty }), humanActor),
  "cycle.archived": ev(
    "cycle.archived",
    z.strictObject({ cycle: cycleNumber, into: relPath }),
    systemActor,
  ),
} as const;

export const eventNames = Object.keys(events) as [EventName, ...EventName[]];

export const event = z.discriminatedUnion("event", [
  events["artifact.committed"],
  events["gate.accepted"],
  events["gate.sent_back"],
  events["stage.entered"],
  events["plan.drafted"],
  events["plan.final"],
  events.question,
  events["tasks.proposed"],
  events["tasks.confirmed"],
  events["session.started"],
  events["session.stopped"],
  events.round,
  events["hook.blocked"],
  events["hook.allowed"],
  events["verifier.result"],
  events["repro.failed"],
  events["repro.confirmed"],
  events["freeze.lifted"],
  events["evals.green"],
  events["evals.red"],
  events["pr.opened"],
  events["pr.merged"],
  events["review.finding"],
  events["deploy.authorized"],
  events["deploy.started"],
  events["deploy.finished"],
  events["deploy.failed"],
  events["record.writeback.ok"],
  events["record.writeback.failed"],
  events["override.mode"],
  events["consult.tech_lead"],
  events.note,
  events["change.created"],
  events["change.closed"],
  events["cycle.archived"],
]);

export type EventName = keyof typeof events;
export type Event = z.infer<typeof event>;
export type EventOf<N extends EventName> = z.infer<(typeof events)[N]>;
export type RoundResult = z.infer<typeof roundResult>;
export type ProposedTask = z.infer<typeof proposedTask>;

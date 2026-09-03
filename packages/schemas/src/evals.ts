import { z } from "zod";
import {
  changeId,
  cycleNumber,
  evalCaseId,
  evalRunId,
  gitSha,
  isoTimestamp,
  nonEmpty,
  ratio,
  relPath,
  schemaVersion,
} from "./common.js";
import { roundResult } from "./event.js";

export const evalCheck = z.strictObject({
  name: nonEmpty,
  cmd: nonEmpty,
  healthyOutput: z.string().optional(),
});

export const evalCaseStatus = z.enum(["draft", "active", "retired"]);

/** `evals/cases/<id>.json` */
export const evalCase = z.strictObject({
  schema: schemaVersion,
  id: evalCaseId,
  prompt: nonEmpty,
  checks: z.array(evalCheck),
  source: z.strictObject({ type: z.enum(["change", "incident", "manual"]), ref: z.string().optional() }),
  owner: nonEmpty,
  added: isoTimestamp,
  status: evalCaseStatus,
  paths: z.array(relPath),
  /** A trigger test: the prompt should load this skill (`.claude/skills/<name>`); its pass feeds the skill's pass % (spec 5A.3). */
  skill: nonEmpty.optional(),
});

export const configRef = z.strictObject({
  claudeMdSha: gitSha,
  skills: z.array(z.strictObject({ name: nonEmpty, version: nonEmpty })),
  hooksSha: gitSha,
  model: nonEmpty,
});

export const evalResult = z.strictObject({
  caseId: evalCaseId,
  pass: z.boolean(),
  output: z.string(),
});

/** `evals/runs/<id>.json` */
export const evalRun = z.strictObject({
  schema: schemaVersion,
  id: evalRunId,
  trigger: z.enum(["schedule", "config-pr", "manual"]),
  configRef,
  results: z.array(evalResult),
  passRate: ratio,
  threshold: ratio,
  verdict: z.enum(["pass", "fail", "incomplete"]),
  cost: z.number().min(0).optional(),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
});

export const commandResult = z.strictObject({
  name: nonEmpty,
  cmd: nonEmpty,
  exitCode: z.number().int(),
  pass: z.boolean(),
  output: z.string(),
});

/** `sdlc/changes/<id>/evals/run-<n>.json` */
export const perChangeRun = z.strictObject({
  schema: schemaVersion,
  n: z.number().int().min(1),
  changeId,
  cycle: cycleNumber,
  worktree: z.string(),
  headSha: gitSha,
  fileSet: z.array(relPath),
  configRef,
  results: z.array(evalResult),
  commandResults: z.array(commandResult),
  verdict: z.enum(["green", "red"]),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
});

/** `sdlc/changes/<id>/evals/final-round.json` */
export const round = z.strictObject({
  schema: schemaVersion,
  n: z.number().int().min(1),
  ts: isoTimestamp,
  results: z.array(roundResult).min(1),
  screenshotRef: z.string().optional(),
  diffPct: z.number().min(0).max(100).optional(),
  filesChangedSinceLast: z.array(relPath).optional(),
});

/** `sdlc/changes/<id>/evals/repro.json` */
export const reproProof = z.strictObject({
  schema: schemaVersion,
  testPath: relPath,
  failureReason: nonEmpty,
  sha: gitSha,
  output: z.string(),
  confirmedBy: nonEmpty,
  confirmedAt: isoTimestamp,
});

export type EvalCase = z.infer<typeof evalCase>;
export type EvalCheck = z.infer<typeof evalCheck>;
export type EvalRun = z.infer<typeof evalRun>;
export type EvalResult = z.infer<typeof evalResult>;
export type ConfigRef = z.infer<typeof configRef>;
export type PerChangeRun = z.infer<typeof perChangeRun>;
export type CommandResult = z.infer<typeof commandResult>;
export type Round = z.infer<typeof round>;
export type ReproProof = z.infer<typeof reproProof>;

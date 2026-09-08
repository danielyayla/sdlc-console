import { z } from "zod";
import { isoTimestamp, nonEmpty, schemaVersion } from "./common.js";

/** `bands.yaml`: control bands for Maintain. Repo config; parsed, never edited. */
export const bandTiers = z.strictObject({
  "1sigma": z.strictObject({ action: z.literal("log") }),
  "2sigma": z.strictObject({ action: z.literal("diagnose"), tools: z.array(nonEmpty) }),
  "3sigma": z.strictObject({ action: z.literal("propose"), routes: z.array(nonEmpty) }),
});

export const controlBand = z.strictObject({
  metric: nonEmpty,
  baseline: z.number(),
  unit: z.string().optional(),
  rules: z.array(nonEmpty).optional(),
  /**
   * How the detection script reads the metric (3.4): a shell command whose
   * last numeric token on stdout is the current value. A band without a
   * source renders "no source" and never breaches.
   */
  source: nonEmpty.optional(),
  /** One standard deviation in the metric's unit; without it the retained snapshots supply the sample deviation once three are on file. */
  sigma: z.number().positive().optional(),
  tiers: bandTiers,
});

/** A pre-approved runbook (3.4): the only commands a 3σ propose job may run, by id. A bare id lists a runbook the console cannot run. */
export const runbook = z.strictObject({
  id: nonEmpty,
  command: nonEmpty,
  description: z.string().optional(),
});

export const bands = z.strictObject({
  baselineWindow: z.string().optional(),
  /** How often `sdlc serve --engine` runs detection (`30s`, `15m`, `1h`; default 15m). */
  detectEvery: z.string().regex(/^\d+(s|m|h)$/, "expected <n>s, <n>m or <n>h").optional(),
  metrics: z.array(controlBand),
  runbooks: z.array(z.union([nonEmpty, runbook])).optional(),
});

export const bandTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/**
 * One detection sample (`.sdlc-state/snapshots/<metric>.jsonl`, 3.4): what
 * the source printed, verbatim, and the tier the deterministic rule gave it.
 * Cache (blueprint §12 C): the last N are retained; the triage item carries
 * the evidence that matters.
 */
export const metricSnapshot = z.strictObject({
  schema: schemaVersion,
  metric: nonEmpty,
  ts: isoTimestamp,
  baseline: z.number(),
  /** Null when the source failed or printed no number; `output` says why. */
  current: z.number().nullable(),
  /** Null while the baseline is still being collected (no `sigma` in bands.yaml and fewer than three samples). */
  sigma: z.number().nullable(),
  tier: bandTier.nullable(),
  breached: z.boolean(),
  source: z.strictObject({ command: nonEmpty, exitCode: z.number().int(), output: z.string() }),
});

/** A runbook invocation record (`sdlc/loop/runbooks/RBK-NNNN.json`): who ran which allowlisted command, and its output verbatim. */
export const runbookRun = z.strictObject({
  schema: schemaVersion,
  id: z.string().regex(/^RBK-\d{4}$/, "expected RBK-NNNN"),
  runbook: nonEmpty,
  command: nonEmpty,
  /** The band whose 3σ propose job triggered it, and the triage item it belongs to. */
  metric: nonEmpty.optional(),
  triage: z.string().regex(/^TRI-\d{4}$/).optional(),
  session: nonEmpty,
  actor: z.strictObject({ type: z.enum(["agent", "human"]), id: nonEmpty }),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  exitCode: z.number().int(),
  output: z.string(),
});

export type Bands = z.infer<typeof bands>;
export type ControlBand = z.infer<typeof controlBand>;
export type Runbook = z.infer<typeof runbook>;
export type MetricSnapshot = z.infer<typeof metricSnapshot>;
export type BandTierNumber = z.infer<typeof bandTier>;
export type RunbookRun = z.infer<typeof runbookRun>;

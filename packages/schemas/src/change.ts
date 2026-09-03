import { z } from "zod";
import {
  changeId,
  changeKind,
  cycleNumber,
  gitSha,
  isoTimestamp,
  nonEmpty,
  riskLevel,
  schemaVersion,
} from "./common.js";

export const originType = z.enum(["idea", "ticket", "triage", "security", "incident", "channel"]);

export const externalRecord = z.strictObject({
  system: nonEmpty,
  id: nonEmpty,
  url: z.url().optional(),
});

export const reproState = z.enum(["none", "drafted", "confirmed", "committed"]);

export const reproBlock = z.strictObject({
  state: reproState,
  testPath: z.string().optional(),
  failureReason: z.string().optional(),
  sha: gitSha.optional(),
});

/** `sdlc/changes/<id>/change.yaml`. Stage is never stored here; it is derived. */
export const change = z.strictObject({
  schema: schemaVersion,
  id: changeId,
  title: nonEmpty,
  kind: changeKind,
  risk: riskLevel,
  created: z.strictObject({ by: nonEmpty, at: isoTimestamp }),
  origin: z.strictObject({ type: originType, ref: z.string().optional() }),
  record: externalRecord.nullable(),
  cycle: cycleNumber,
  repro: reproBlock.nullable(),
  closed: z.strictObject({ at: isoTimestamp, reason: nonEmpty }).nullable(),
});

export type Change = z.infer<typeof change>;
export type ReproBlock = z.infer<typeof reproBlock>;
export type ExternalRecord = z.infer<typeof externalRecord>;
export type OriginType = z.infer<typeof originType>;

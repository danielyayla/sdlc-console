import { z } from "zod";
import { changeId, isoTimestamp, nonEmpty, schemaVersion, triageId, triageTier } from "./common.js";

export const dismissal = z.strictObject({
  by: nonEmpty,
  reason: nonEmpty,
  at: isoTimestamp.optional(),
});

/** Front-matter of `sdlc/loop/triage/TRI-NNNN.md`; the body is a pre-drafted intent. */
export const triage = z.strictObject({
  schema: schemaVersion,
  id: triageId,
  tier: triageTier,
  src: nonEmpty,
  title: nonEmpty,
  evidence: z.string(),
  createdAt: isoTimestamp,
  status: z.enum(["open", "accepted", "dismissed"]),
  dismissal: dismissal.extend({ bandTune: z.string().optional() }).optional(),
  acceptedAs: changeId.optional(),
});

export type Triage = z.infer<typeof triage>;
export type Dismissal = z.infer<typeof dismissal>;

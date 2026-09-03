import { z } from "zod";
import { isoTimestamp, nonEmpty, proposalId, schemaVersion } from "./common.js";
import { dismissal } from "./triage.js";

/** `sdlc/proposals/PRP-NNNN.yaml` */
export const proposal = z.strictObject({
  schema: schemaVersion,
  id: proposalId,
  type: z.enum(["claude-md-line", "test-change"]),
  text: nonEmpty,
  citations: z.array(nonEmpty),
  status: z.enum(["open", "accepted", "dismissed"]),
  pr: z.strictObject({ number: z.number().int().min(1).optional(), url: z.url().optional() }).optional(),
  createdAt: isoTimestamp,
  dismissal: dismissal.optional(),
});

export type Proposal = z.infer<typeof proposal>;

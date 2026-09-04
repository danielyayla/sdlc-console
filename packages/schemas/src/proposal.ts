import { z } from "zod";
import { isoTimestamp, nonEmpty, proposalId, schemaVersion } from "./common.js";
import { dismissal } from "./triage.js";

/** `sdlc/proposals/PRP-NNNN.yaml` */
export const proposal = z.strictObject({
  schema: schemaVersion,
  id: proposalId,
  type: z.enum(["claude-md-line", "test-change"]),
  /** One line: it is appended to CLAUDE.md verbatim. */
  text: nonEmpty.refine((t) => !/[\r\n]/.test(t), "a proposal is one line"),
  citations: z.array(nonEmpty),
  /** The normalised repeat reason (lowercase, trimmed) this proposal answers; a third occurrence counts onto it instead of filing another (FR-43). */
  reason: nonEmpty.optional(),
  status: z.enum(["open", "accepted", "dismissed"]),
  /** Where the accepted line waits for the code owners: the proposal branch, and the pull request in GitHub mode. */
  pr: z.strictObject({ branch: nonEmpty.optional(), number: z.number().int().min(1).optional(), url: z.url().optional() }).optional(),
  createdAt: isoTimestamp,
  dismissal: dismissal.optional(),
});

export type Proposal = z.infer<typeof proposal>;

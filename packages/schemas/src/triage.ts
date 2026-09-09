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
  /** The engine job that raised the item from a band breach (3.4), `band:<metric>:<tier>σ:<snapshot ts>`. */
  job: nonEmpty.optional(),
  /** The headless session whose diagnosis or proposal the body carries. */
  session: nonEmpty.optional(),
  /** The channel message a `channel` item came from (3.5, Claude Tag); one item per `messageId`. */
  channel: z
    .strictObject({
      name: nonEmpty,
      workspace: nonEmpty.optional(),
      messageId: nonEmpty,
      permalink: z.url(),
      author: nonEmpty,
      postedAt: isoTimestamp.optional(),
      tags: z.array(nonEmpty).optional(),
    })
    .optional(),
});

export type Triage = z.infer<typeof triage>;
export type Dismissal = z.infer<typeof dismissal>;

import { z } from "zod";
import { gitSha, isoTimestamp, nonEmpty, schemaVersion } from "./common.js";

/** `sdlc/changes/<id>/pr.yaml`: mirror of the code-host PR (or a local branch merge). */
export const pr = z.strictObject({
  schema: schemaVersion,
  provider: z.enum(["github", "local"]),
  number: z.number().int().min(1).optional(),
  url: z.url().optional(),
  branch: nonEmpty,
  baseBranch: nonEmpty,
  headSha: gitSha,
  mergeSha: gitSha.optional(),
  openedAt: isoTimestamp,
  mergedAt: isoTimestamp.optional(),
  reviewers: z.array(nonEmpty),
  findings: z
    .strictObject({
      high: z.number().int().min(0),
      medium: z.number().int().min(0),
      low: z.number().int().min(0),
    })
    .optional(),
  checks: z.array(
    z.strictObject({ name: nonEmpty, verdict: z.enum(["pass", "fail", "pending"]) }),
  ),
  planMatches: z.boolean().nullable(),
});

export type Pr = z.infer<typeof pr>;

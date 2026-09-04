import { z } from "zod";
import { gitSha, isoTimestamp, nonEmpty, relPath, schemaVersion } from "./common.js";
import { dismissal } from "./triage.js";

/**
 * A finding the system raised on the PR itself (spec 5B.3 fallback): a test
 * file changed during a fix where no managed hook could block the edit. It
 * blocks the console's merge until a human dismisses it with a reason.
 */
export const autoFinding = z.strictObject({
  rule: z.enum(["test-freeze"]),
  path: relPath,
  title: nonEmpty,
  detail: z.string(),
  dismissal: dismissal.optional(),
});

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
    z.strictObject({
      name: nonEmpty,
      verdict: z.enum(["pass", "fail", "pending"]),
      /** One line, literal (a count, a sha, a verdict); never a summary of the output. */
      summary: z.string().optional(),
    }),
  ),
  planMatches: z.boolean().nullable(),
  autoFindings: z.array(autoFinding).optional(),
  /** The review job that ran against `headSha`; absent until a review session has finished. */
  review: z
    .strictObject({
      session: nonEmpty,
      headSha: gitSha,
      at: isoTimestamp,
    })
    .optional(),
});

export type Pr = z.infer<typeof pr>;
export type AutoFinding = z.infer<typeof autoFinding>;

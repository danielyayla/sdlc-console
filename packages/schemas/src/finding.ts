import { z } from "zod";
import { changeId, findingId, isoTimestamp, nonEmpty, ratio, schemaVersion, severity } from "./common.js";
import { dismissal } from "./triage.js";

export const findingStatus = z.enum(["new", "patch_pr", "escalated", "dismissed"]);

/** The scan run that last reported a finding (3.5, Claude Security webhook). */
export const scanRun = z.strictObject({
  id: nonEmpty,
  url: z.url().optional(),
  /** When the run reported it (the run's `finishedAt`, else `startedAt`, else the delivery time). */
  at: isoTimestamp.optional(),
  /** The commit the scanner looked at, when it said. */
  commit: z.string().optional(),
});

/** `sdlc/security/findings/SEC-NNNN.yaml`; the scanner owns the finding, the console owns routing status. */
export const finding = z.strictObject({
  schema: schemaVersion,
  id: findingId,
  scannerId: nonEmpty,
  sev: severity,
  conf: ratio,
  validated: z.boolean().optional(),
  repo: nonEmpty,
  title: nonEmpty,
  desc: z.string(),
  status: findingStatus,
  dismissal: dismissal.optional(),
  escalatedTo: changeId.optional(),
  patchPr: z.strictObject({ number: z.number().int().min(1).optional(), url: z.url().optional() }).optional(),
  // ---- scanner-owned fields written by the intake (3.5); absent on CSV/MD imports ----
  /** Which intake wrote the finding, e.g. `claude-security`. */
  source: nonEmpty.optional(),
  run: scanRun.optional(),
  location: z.strictObject({ path: nonEmpty, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }).optional(),
  rule: nonEmpty.optional(),
  cwe: nonEmpty.optional(),
  /** The scanner's evidence verbatim (snippet, trace, reasoning); shown as-is, never summarised. */
  evidence: z.string().optional(),
  /** Where the scanner shows the finding. */
  url: z.url().optional(),
  /** Set when the scanner reported the finding resolved; the routing `status` and the file stay as history. Cleared when it is reported open again. */
  resolved: z.strictObject({ at: isoTimestamp, run: nonEmpty }).optional(),
});

export type Finding = z.infer<typeof finding>;
export type FindingStatus = z.infer<typeof findingStatus>;

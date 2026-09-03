import { z } from "zod";
import { changeId, findingId, nonEmpty, ratio, schemaVersion, severity } from "./common.js";
import { dismissal } from "./triage.js";

export const findingStatus = z.enum(["new", "patch_pr", "escalated", "dismissed"]);

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
});

export type Finding = z.infer<typeof finding>;
export type FindingStatus = z.infer<typeof findingStatus>;

import { z } from "zod";
import {
  changeId,
  cycleNumber,
  gitSha,
  isoTimestamp,
  nonEmpty,
  relPath,
  schemaVersion,
  triageTier,
} from "./common.js";

const shared = {
  schema: schemaVersion,
  id: changeId,
  cycle: cycleNumber,
  /** Hash of the ContextManifest when agent-produced (blueprint §8.10). */
  context_manifest: z.string().optional(),
};

/** `intent.md` front-matter */
export const intentFrontMatter = z.strictObject({
  ...shared,
  artifact: z.literal("intent"),
  author: nonEmpty,
  created: isoTimestamp,
  status: z.enum(["draft", "final"]).optional(),
});

export const specConcern = z.strictObject({
  id: nonEmpty,
  policy: nonEmpty,
  owner: nonEmpty,
  resolved: z.boolean(),
  note: z.string().optional(),
});

/** `spec.md` front-matter */
export const specFrontMatter = z.strictObject({
  ...shared,
  artifact: z.literal("spec"),
  intent_sha: gitSha,
  prompt_ref: z.string().nullable().optional(),
  skills: z.array(z.strictObject({ name: nonEmpty, version: nonEmpty })),
  concerns: z.array(specConcern),
  created: isoTimestamp,
  author: z.string().optional(),
});

/** `plan.md` front-matter; `files` is optional here because the body's "Files that change" is authoritative. */
export const planFrontMatter = z.strictObject({
  ...shared,
  artifact: z.literal("plan"),
  spec_sha: gitSha.nullable(),
  rev: z.number().int().min(1),
  accepted_by: nonEmpty.nullable(),
  accepted_at: isoTimestamp.nullable(),
  acceptance_line: z.string(),
  files: z.array(relPath).optional(),
});

/** `incident.md` front-matter */
export const incidentFrontMatter = z.strictObject({
  ...shared,
  artifact: z.literal("incident"),
  src: nonEmpty,
  tier: triageTier,
  created: isoTimestamp,
});

export type IntentFrontMatter = z.infer<typeof intentFrontMatter>;
export type SpecFrontMatter = z.infer<typeof specFrontMatter>;
export type SpecConcern = z.infer<typeof specConcern>;
export type PlanFrontMatter = z.infer<typeof planFrontMatter>;
export type IncidentFrontMatter = z.infer<typeof incidentFrontMatter>;

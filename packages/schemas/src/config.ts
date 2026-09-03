import { z } from "zod";
import { artifactName, nonEmpty, ratio, recordsMode, role, schemaVersion } from "./common.js";

export const identity = z.strictObject({
  id: nonEmpty,
  name: z.string().optional(),
  roles: z.array(role).min(1),
  skillsOwned: z.array(nonEmpty).optional(),
  /** Code-host login, so a merge performed on GitHub can be attributed to this identity. */
  github: nonEmpty.optional(),
});

export const thresholds = z.strictObject({
  /** files-in-plan ≤ this → AUTO eligible term holds */
  autoFilesMax: z.number().int().min(1).optional(),
  evalPassThreshold: ratio.optional(),
  maxLoopRounds: z.number().int().min(1).optional(),
  /** Review backlog above which no new session starts; `null` = no ceiling (header shows counts only). */
  sessionCeiling: z.number().int().min(1).nullable().optional(),
  suiteMinSize: z.number().int().min(0).optional(),
  noDiscriminationRuns: z.number().int().min(1).optional(),
  brokenCheckRuns: z.number().int().min(1).optional(),
  /** Share of a skill's trigger tests that must load it; below → amber and a "skill not triggering" triage item. */
  skillPassThreshold: ratio.optional(),
});

/** Defaults applied by core when `sdlc/config.yaml` leaves a threshold unset. */
export const CONFIG_DEFAULTS = {
  thresholds: {
    autoFilesMax: 12,
    evalPassThreshold: 0.9,
    maxLoopRounds: 5,
    sessionCeiling: 4,
    suiteMinSize: 20,
    noDiscriminationRuns: 20,
    brokenCheckRuns: 3,
    skillPassThreshold: 0.8,
  },
  evals: { mode: "continuous" as const },
  eligibility: { coverage: "lenient" as const },
} as const;

export const recordsMapping = z.strictObject({
  intent: recordsMode.optional(),
  spec: recordsMode.optional(),
  plan: recordsMode.optional(),
  evals: recordsMode.optional(),
  pr: recordsMode.optional(),
  incident: recordsMode.optional(),
  connector: z.string().optional(),
});

/** `sdlc/config.yaml`. Parsed by the console, never edited by it. */
export const config = z.strictObject({
  schema: schemaVersion,
  defaultRole: z.enum(["po", "eng"]),
  defaultBranch: z.string().optional(),
  /** Where gates that need a PR are executed; local mode has no PRs and lets a tech lead accept high-risk plans via CLI. */
  codeHost: z.enum(["local", "github"]).optional(),
  identities: z.array(identity).min(1),
  /** Extra roles (decisions Q15) gate non-gate actions or PR reviews only. */
  roles: z
    .array(z.strictObject({ name: role, description: z.string().optional() }))
    .optional(),
  thresholds: thresholds.optional(),
  records: recordsMapping.optional(),
  evals: z
    .strictObject({
      mode: z.enum(["continuous", "scheduled"]).optional(),
      threshold: ratio.optional(),
      budget: z.number().min(0).optional(),
      schedule: z.string().optional(),
    })
    .optional(),
  eligibility: z.strictObject({ coverage: z.enum(["strict", "lenient"]).optional() }).optional(),
  products: z.array(z.strictObject({ name: nonEmpty, path: nonEmpty })).optional(),
  intentHome: z.string().optional(),
  /** Artifact names whose acceptance is recorded elsewhere; informational. */
  artifacts: z.array(artifactName).optional(),
});

export type Config = z.infer<typeof config>;
export type Identity = z.infer<typeof identity>;
export type Thresholds = z.infer<typeof thresholds>;
export type RecordsMapping = z.infer<typeof recordsMapping>;

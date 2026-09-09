import { z } from "zod";
import { artifactName, nonEmpty, ratio, recordsMode, role, schemaVersion } from "./common.js";
import { environmentKind } from "./deploy.js";

const command = z.strictObject({ command: nonEmpty });

/**
 * A deployment environment (3.6). The commands are the only ones the console
 * ever runs for it — an agent's `deploy_<env>` tool and a person's
 * `sdlc deploy <env>` both run `deploy.command`, never a caller's string.
 * `production` is the one kind behind a human gate: `gate.roles` names who
 * may open it (default: gate 5's owner, `eng`); every other kind is
 * agent-deployable and is where the rollback is rehearsed.
 */
export const environment = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "expected an environment slug"),
  kind: environmentKind,
  description: z.string().optional(),
  deploy: command,
  rollback: command,
  healthcheck: command.optional(),
  /** Production only: roles that own the production gate (default `[eng]`). */
  gate: z.strictObject({ roles: z.array(role).min(1) }).optional(),
});

export const identity = z.strictObject({
  id: nonEmpty,
  name: z.string().optional(),
  roles: z.array(role).min(1),
  skillsOwned: z.array(nonEmpty).optional(),
  /** Code-host login, so a merge performed on GitHub can be attributed to this identity. */
  github: nonEmpty.optional(),
  /** OIDC subject (`sub`) in hosted mode; without it the provider's `auth.claim` (email by default) must equal `id`. */
  subject: nonEmpty.optional(),
});

/** Hosted mode (3.1): who may open the console is decided by the identity provider, what they may do by `identities`. */
export const auth = z.strictObject({
  provider: z.literal("oidc"),
  issuer: z.string().url(),
  clientId: nonEmpty,
  /** Expected `aud`; defaults to `clientId`. */
  audience: nonEmpty.optional(),
  /** Claim matched against `identities[].id` when no `subject` matches (default email). */
  claim: z.enum(["email", "preferred_username", "sub"]).optional(),
  scopes: z.array(nonEmpty).optional(),
  /** Public origin of the console (behind a proxy or tunnel); defaults to the request's Host. */
  publicUrl: z.string().url().optional(),
  sessionHours: z.number().int().min(1).max(24 * 30).optional(),
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
  /** Name of the MCP server in `.mcp.json` (`mcpServers.<name>`) that owns the external records: `record_get` and `record_write_back` tools (FR-16). */
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
  /** Hosted mode login; absent = local mode (git identity + role switcher). */
  auth: auth.optional(),
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
  /**
   * Products the console serves (3.2). One entry per SDLC home: `path` is the
   * directory holding that product's `sdlc/` (`.` for this home; a subdirectory
   * for a monorepo product with its own `sdlc/config.yaml`). Absent = one
   * product, this home, named after the repository directory.
   */
  products: z
    .array(
      z.strictObject({
        name: nonEmpty,
        path: nonEmpty,
        description: z.string().optional(),
      }),
    )
    .optional(),
  intentHome: z.string().optional(),
  /** Deployment environments (3.6); absent = no deploy tools, no production gate. Names are unique (a core rule: Ajv validates the generated JSON Schema, which cannot say so). */
  environments: z.array(environment).optional(),
  /** Artifact names whose acceptance is recorded elsewhere; informational. */
  artifacts: z.array(artifactName).optional(),
});

export type Config = z.infer<typeof config>;
export type Identity = z.infer<typeof identity>;
export type Environment = z.infer<typeof environment>;
export type Thresholds = z.infer<typeof thresholds>;
export type RecordsMapping = z.infer<typeof recordsMapping>;

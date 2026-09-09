import { z } from "zod";
import { gitSha, isoTimestamp, nonEmpty, schemaVersion } from "./common.js";

/** Environment kinds (3.6): only `production` sits behind a human gate; the others are agent-deployable. */
export const environmentKind = z.enum(["preview", "staging", "production"]);

/** One deployment's state. `pending` is declared, `running` is the command in flight, the rest are outcomes. */
export const deploymentStatus = z.enum(["pending", "running", "succeeded", "failed", "rolled_back"]);

/** Who ran a deployment or a rehearsal: a person (the production gate), an agent session (a non-production deploy) or the system. */
export const deployActor = z.strictObject({
  type: z.enum(["human", "agent", "system"]),
  id: nonEmpty,
  session: z.string().optional(),
});

/**
 * One deployment of this change to one environment (3.6): the commit
 * deployed, the declared command that ran, its output verbatim (clipped with
 * a note when huge, never summarised) and who ran it. Production entries also
 * carry the gate decision that authorized them.
 */
export const deployment = z.strictObject({
  env: nonEmpty,
  kind: environmentKind.optional(),
  status: deploymentStatus,
  /** Commit deployed. */
  sha: gitSha,
  version: z.string().optional(),
  /** The environment's declared deploy command, as `sdlc/config.yaml` spelled it. */
  command: nonEmpty,
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
  exitCode: z.number().int().optional(),
  /** Command output, verbatim. */
  output: z.string(),
  actor: deployActor,
  /** Production: the person whose gate decision authorized this deploy, and when. */
  authorizedBy: nonEmpty.optional(),
  authorizedAt: isoTimestamp.optional(),
  /** The declared healthcheck's outcome, when the environment has one. */
  healthcheck: z.strictObject({ command: nonEmpty, exitCode: z.number().int(), output: z.string() }).optional(),
  /** `RBK-NNNN` when a runbook deployed it (a 3σ propose job), or the rehearsal index this deploy answers. */
  runbook: z.string().regex(/^RBK-\d{4}$/).optional(),
});

/** A rollback rehearsal (3.6): the environment's rollback command run against a non-production environment at the sha it had deployed, output verbatim. */
export const rollbackRehearsal = z.strictObject({
  env: nonEmpty,
  kind: environmentKind.optional(),
  /** The commit the environment was running when the rollback was rehearsed — the sha the production gate is asked about. */
  sha: gitSha,
  status: z.enum(["succeeded", "failed"]),
  command: nonEmpty,
  rehearsedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
  exitCode: z.number().int(),
  output: z.string(),
  actor: deployActor,
});

/**
 * `sdlc/changes/<id>/deploy.yaml`: one record per change per cycle. The
 * headline fields (`env`, `version`, `at`, `status`) describe the latest
 * deployment; `environments[]` holds every deployment in order and
 * `rehearsals[]` every rollback rehearsal (3.6). Records written before 3.6
 * carry the headline alone and stay valid.
 */
export const deploy = z.strictObject({
  schema: schemaVersion,
  env: nonEmpty,
  version: nonEmpty,
  at: isoTimestamp,
  status: z.enum(["started", "pending", "running", "succeeded", "failed", "rolled_back"]),
  authorizedBy: z.string().optional(),
  authorizedAt: isoTimestamp.optional(),
  environments: z.array(deployment).optional(),
  rehearsals: z.array(rollbackRehearsal).optional(),
});

export type Deploy = z.infer<typeof deploy>;
export type Deployment = z.infer<typeof deployment>;
export type DeploymentStatus = z.infer<typeof deploymentStatus>;
export type RollbackRehearsal = z.infer<typeof rollbackRehearsal>;
export type EnvironmentKind = z.infer<typeof environmentKind>;
export type DeployActor = z.infer<typeof deployActor>;

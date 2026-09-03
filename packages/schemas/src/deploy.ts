import { z } from "zod";
import { isoTimestamp, nonEmpty, schemaVersion } from "./common.js";

/** `sdlc/changes/<id>/deploy.yaml` */
export const deploy = z.strictObject({
  schema: schemaVersion,
  env: nonEmpty,
  version: nonEmpty,
  at: isoTimestamp,
  status: z.enum(["started", "succeeded", "failed", "rolled_back"]),
  authorizedBy: z.string().optional(),
  authorizedAt: isoTimestamp.optional(),
});

export type Deploy = z.infer<typeof deploy>;

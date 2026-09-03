import { z } from "zod";
import { nonEmpty } from "./common.js";

/** `bands.yaml`: control bands for Maintain. Repo config; parsed, never edited. */
export const bandTiers = z.strictObject({
  "1sigma": z.strictObject({ action: z.literal("log") }),
  "2sigma": z.strictObject({ action: z.literal("diagnose"), tools: z.array(nonEmpty) }),
  "3sigma": z.strictObject({ action: z.literal("propose"), routes: z.array(nonEmpty) }),
});

export const controlBand = z.strictObject({
  metric: nonEmpty,
  baseline: z.number(),
  unit: z.string().optional(),
  rules: z.array(nonEmpty).optional(),
  tiers: bandTiers,
});

export const bands = z.strictObject({
  baselineWindow: z.string().optional(),
  metrics: z.array(controlBand),
  runbooks: z.array(nonEmpty).optional(),
});

export type Bands = z.infer<typeof bands>;
export type ControlBand = z.infer<typeof controlBand>;

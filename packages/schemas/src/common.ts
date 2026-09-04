import { z } from "zod";

/** Every `sdlc/` file declares `schema: 1`. Bump only with a migration. */
export const SCHEMA_VERSION = 1 as const;
export const schemaVersion = z.literal(SCHEMA_VERSION);

// ---------- identifiers ----------
export const changeId = z.string().regex(/^CHG-\d{4}$/, "expected CHG-NNNN");
export const triageId = z.string().regex(/^TRI-\d{4}$/, "expected TRI-NNNN");
export const findingId = z.string().regex(/^SEC-\d{4}$/, "expected SEC-NNNN");
export const proposalId = z.string().regex(/^PRP-\d{4}$/, "expected PRP-NNNN");
export const evalCaseId = z
  .string()
  .regex(/^(CASE|INC)-[A-Za-z0-9][A-Za-z0-9-]*$/, "expected CASE-… or INC-…");
export const evalRunId = z.string().regex(/^RUN-[A-Za-z0-9][A-Za-z0-9-]*$/, "expected RUN-…");
export const taskId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "expected a lowercase slug");
export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID");
export const gitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "expected a git SHA");
export const isoTimestamp = z.iso.datetime({ offset: true });
export const nonEmpty = z.string().min(1);
export const relPath = z.string().min(1);

// ---------- numbers ----------
export const artifactIndex = z.number().int().min(0).max(5);
export const stageNumber = z.number().int().min(1).max(6);
export const gateNumber = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(6),
]);
export const cycleNumber = z.number().int().min(1);
export const ratio = z.number().min(0).max(1);

// ---------- enums ----------
export const artifactName = z.enum(["intent", "spec", "plan", "evals", "pr", "incident"]);
export const riskLevel = z.enum(["routine", "high"]);
export const changeKind = z.enum(["feature", "fix"]);
export const sessionMode = z.enum(["AUTO", "PLAN", "SUPERVISED", "HEADLESS"]);
export const recordsMode = z.enum(["repo", "external", "linked"]);
/** What a write-back tells the external record: the artifact was committed at a sha (linked mode), or accepted at a gate (external and linked). */
export const writebackKind = z.enum(["committed", "accepted"]);
export const gateRole = z.enum(["po", "eng", "tech_lead"]);
export const role = z.string().regex(/^[a-z][a-z0-9_]*$/, "expected a role slug");
export const triageTier = z.enum([
  "1σ",
  "2σ",
  "3σ",
  "incident",
  "flaky",
  "eval-retire",
  "skill-trigger",
  "channel",
]);
export const severity = z.enum(["high", "medium", "low"]);

// ---------- actors ----------
const actorFields = { id: nonEmpty, role: role.optional() };
export const humanActor = z.strictObject({
  type: z.literal("human"),
  ...actorFields,
  session: z.string().optional(),
});
/** Agent-authored events must carry the session that produced them. */
export const agentActor = z.strictObject({
  type: z.literal("agent"),
  ...actorFields,
  session: nonEmpty,
});
export const systemActor = z.strictObject({
  type: z.literal("system"),
  ...actorFields,
  session: z.string().optional(),
});
export const actor = z.discriminatedUnion("type", [humanActor, agentActor, systemActor]);

export type Actor = z.infer<typeof actor>;
export type ArtifactName = z.infer<typeof artifactName>;
export type RiskLevel = z.infer<typeof riskLevel>;
export type ChangeKind = z.infer<typeof changeKind>;
export type SessionMode = z.infer<typeof sessionMode>;
export type RecordsMode = z.infer<typeof recordsMode>;
export type WritebackKind = z.infer<typeof writebackKind>;
export type GateNumber = z.infer<typeof gateNumber>;
export type TriageTier = z.infer<typeof triageTier>;
export type Severity = z.infer<typeof severity>;

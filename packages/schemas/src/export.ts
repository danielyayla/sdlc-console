import { z } from "zod";
import { change } from "./change.js";
import { artifactIndex, cycleNumber, gateNumber, gitSha, isoTimestamp, nonEmpty, schemaVersion, severity, stageNumber, ulid } from "./common.js";
import { deploy } from "./deploy.js";
import { perChangeRun } from "./evals.js";
import { event } from "./event.js";
import { pr } from "./pr.js";

/** One committed artifact file of a cycle, verbatim, with the blob sha the ledger's `artifact.committed` / `gate.accepted` lines name. */
export const exportArtifact = z.strictObject({
  index: artifactIndex,
  name: nonEmpty,
  path: nonEmpty,
  sha: gitSha,
  frontMatter: z.record(z.string(), z.unknown()).nullable(),
  content: z.string(),
});

/** A gate decision as the ledger recorded it, plus the commit that carries its `SDLC-Event` trailer when the exporter could resolve it. */
export const exportDecision = z.strictObject({
  eventId: ulid,
  cycle: cycleNumber,
  seq: z.number().int().min(1),
  ts: isoTimestamp,
  gate: gateNumber,
  decision: z.enum(["accepted", "sent_back"]),
  by: z.strictObject({ id: nonEmpty, role: z.string().nullable() }),
  source: z.enum(["cli", "console", "pr.merge"]).nullable(),
  artifactSha: gitSha.nullable(),
  note: z.string().nullable(),
  commit: gitSha.nullable(),
});

export const exportFinding = z.strictObject({
  eventId: ulid,
  cycle: cycleNumber,
  ts: isoTimestamp,
  severity,
  title: nonEmpty,
  path: z.string().nullable(),
  detail: z.string().nullable(),
  session: z.string().nullable(),
});

export const exportArtifactPr = z.strictObject({
  artifact: artifactIndex,
  number: z.number().int().min(1).nullable(),
  url: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: gitSha,
});

export const exportMerge = z.strictObject({
  eventId: ulid,
  ts: isoTimestamp,
  number: z.number().int().min(1).nullable(),
  mergeSha: gitSha,
});

export const exportCycle = z.strictObject({
  cycle: cycleNumber,
  archived: z.boolean(),
  dir: nonEmpty,
  artifacts: z.array(exportArtifact),
  decisions: z.array(exportDecision),
  pr: pr.nullable(),
  artifactPrs: z.array(exportArtifactPr),
  merges: z.array(exportMerge),
  runs: z.array(perChangeRun),
  findings: z.array(exportFinding),
  deploy: deploy.nullable(),
});

export const exportDiagnostic = z.strictObject({
  path: z.string(),
  pointer: z.string().optional(),
  line: z.number().int().optional(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  rule: z.string(),
});

/**
 * Compliance export of one change (`sdlc export <CHG>`, `GET /api/changes/<CHG>/export`):
 * everything an auditor needs in one self-contained document, derived from the
 * tree alone. `contentHash` is sha256 over the canonical JSON (keys sorted,
 * no whitespace) of the document without the `contentHash` field.
 */
export const changeExport = z.strictObject({
  schema: schemaVersion,
  kind: z.literal("change-export"),
  exportedAt: isoTimestamp,
  exportedBy: z.strictObject({ id: nonEmpty, name: z.string().optional() }),
  /** The tree the export was read at (a commit sha when read from git; null for a synthetic tree). */
  ref: z.string().nullable(),
  change: change.nullable(),
  derived: z.strictObject({
    stage: stageNumber,
    stageName: nonEmpty,
    status: z.string(),
    acceptedGates: z.array(gateNumber),
    valid: z.boolean(),
    validationErrors: z.array(exportDiagnostic),
  }),
  cycles: z.array(exportCycle),
  events: z.array(event),
  evalCases: z.array(z.strictObject({ id: nonEmpty, status: z.enum(["draft", "active", "retired"]), source: z.strictObject({ type: z.enum(["change", "incident", "manual"]), ref: z.string().optional() }) })),
  contentHash: z.strictObject({ algorithm: z.literal("sha256"), over: z.literal("canonical-json"), value: z.string().regex(/^[0-9a-f]{64}$/) }),
});

export type ChangeExport = z.infer<typeof changeExport>;
export type ExportCycle = z.infer<typeof exportCycle>;
export type ExportArtifact = z.infer<typeof exportArtifact>;
export type ExportDecision = z.infer<typeof exportDecision>;
export type ExportFinding = z.infer<typeof exportFinding>;

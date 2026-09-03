import { z } from "zod";
import { bands } from "./bands.js";
import { change } from "./change.js";
import { config } from "./config.js";
import { deploy } from "./deploy.js";
import { evalCase, evalRun, perChangeRun, reproProof, round } from "./evals.js";
import { event } from "./event.js";
import { finding } from "./finding.js";
import {
  incidentFrontMatter,
  intentFrontMatter,
  planFrontMatter,
  specFrontMatter,
} from "./frontmatter.js";
import { pr } from "./pr.js";
import { proposal } from "./proposal.js";
import { tasks } from "./tasks.js";
import { triage } from "./triage.js";

/** Every schema by name. The name is also the JSON Schema `$id` and the file under `json/`. */
export const registry = {
  change,
  event,
  config,
  tasks,
  "eval-case": evalCase,
  "eval-run": evalRun,
  "per-change-run": perChangeRun,
  round,
  "repro-proof": reproProof,
  pr,
  deploy,
  triage,
  finding,
  proposal,
  "intent-frontmatter": intentFrontMatter,
  "spec-frontmatter": specFrontMatter,
  "plan-frontmatter": planFrontMatter,
  "incident-frontmatter": incidentFrontMatter,
  bands,
} as const;

export type SchemaName = keyof typeof registry;
export type EntityOf<K extends SchemaName> = z.infer<(typeof registry)[K]>;
export const schemaNames = Object.keys(registry) as SchemaName[];

export type JsonSchema = Record<string, unknown>;

const JSON_SCHEMA_ID_BASE = "https://sdlc.local/schemas/";

/**
 * Turn a zod union over literal-discriminated objects into `oneOf` with an
 * OpenAPI `discriminator`, which Ajv uses to report errors against the one
 * matching branch instead of every branch.
 */
function discriminate(schema: JsonSchema, propertyName: string): JsonSchema {
  const branches = schema["oneOf"] ?? schema["anyOf"];
  if (!Array.isArray(branches)) return schema;
  const { anyOf: _a, oneOf: _o, ...rest } = schema;
  void _a;
  void _o;
  return { ...rest, type: "object", oneOf: branches, discriminator: { propertyName } };
}

function toJson(name: SchemaName, schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonSchema;
  const withId: JsonSchema = { $id: `${JSON_SCHEMA_ID_BASE}${name}.schema.json`, ...json };
  return name === "event" ? discriminate(withId, "event") : withId;
}

/** JSON Schema 2020-12 for every entity, generated from the zod source of truth. */
export const jsonSchemas: Record<SchemaName, JsonSchema> = Object.fromEntries(
  schemaNames.map((name) => [name, toJson(name, registry[name])]),
) as Record<SchemaName, JsonSchema>;

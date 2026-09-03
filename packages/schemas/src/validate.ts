import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv and ajv-formats ship CommonJS with `exports.default`; under NodeNext the
// default import is the module namespace, so the class/function live on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
import { jsonSchemas, schemaNames, type EntityOf, type SchemaName } from "./registry.js";

/** Structured diagnostic, shared by every layer (blueprint §7.2). */
export interface Diagnostic {
  /** File path the diagnostic is about; empty when validating a bare value. */
  path: string;
  /** JSON pointer inside the value, e.g. `/created/at`. */
  pointer?: string;
  line?: number;
  severity: "error" | "warning";
  message: string;
  /** Rule identifier, e.g. `schema.change`. */
  rule: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; diagnostics: Diagnostic[] };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  discriminator: true,
  allowUnionTypes: true,
});
addFormats(ajv);

const validators = new Map<SchemaName, ValidateFunction>();
for (const name of schemaNames) {
  validators.set(name, ajv.compile(jsonSchemas[name]));
}

function describe(err: ErrorObject): string {
  if (err.keyword === "additionalProperties") {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return `unexpected property "${extra ?? "?"}"`;
  }
  if (err.keyword === "discriminator") {
    return `unknown discriminator value (${err.message ?? "invalid"})`;
  }
  return err.message ?? err.keyword;
}

/** Validate a parsed value against a named schema; never throws. */
export function validate<K extends SchemaName>(
  name: K,
  value: unknown,
  filePath = "",
): ValidationResult<EntityOf<K>> {
  const fn = validators.get(name);
  if (!fn) {
    return {
      ok: false,
      diagnostics: [
        { path: filePath, severity: "error", message: `unknown schema "${name}"`, rule: "schema.unknown" },
      ],
    };
  }
  if (fn(value)) {
    return { ok: true, value: value as EntityOf<K>, diagnostics: [] };
  }
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const err of fn.errors ?? []) {
    const message = describe(err);
    const key = `${err.instancePath}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      path: filePath,
      pointer: err.instancePath === "" ? "/" : err.instancePath,
      severity: "error",
      message,
      rule: `schema.${name}`,
    });
  }
  return { ok: false, diagnostics };
}

/** True when the value satisfies the schema; a typed guard for callers that only need a boolean. */
export function is<K extends SchemaName>(name: K, value: unknown): value is EntityOf<K> {
  return validate(name, value).ok;
}

import { parseDocument } from "yaml";
import type { Diagnostic } from "../validate.js";
import { validate } from "../validate.js";
import type { EntityOf, SchemaName } from "../registry.js";
import { error, fail, finish, type ParseResult } from "./result.js";

/** Parse YAML text into a plain value; syntax errors carry line numbers. */
export function parseYamlValue(text: string, path: string): ParseResult<unknown> {
  const doc = parseDocument(text);
  const diagnostics: Diagnostic[] = doc.errors.map((e) =>
    error(path, "parse.yaml", e.message, e.linePos?.[0]?.line),
  );
  if (diagnostics.length > 0) return fail(diagnostics);
  return finish(doc.toJS() as unknown, []);
}

/** Parse a YAML file and validate it against a named schema. */
export function parseYaml<K extends SchemaName>(
  name: K,
  text: string,
  path: string,
): ParseResult<EntityOf<K>> {
  const raw = parseYamlValue(text, path);
  if (!raw.ok) return fail(raw.diagnostics);
  const result = validate(name, raw.value, path);
  return result.ok ? finish(result.value, []) : fail(result.diagnostics);
}

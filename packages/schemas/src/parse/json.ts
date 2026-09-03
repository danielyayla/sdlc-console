import { validate } from "../validate.js";
import type { EntityOf, SchemaName } from "../registry.js";
import { error, fail, finish, type ParseResult } from "./result.js";

export function parseJsonValue(text: string, path: string): ParseResult<unknown> {
  try {
    return finish(JSON.parse(text) as unknown, []);
  } catch (e) {
    return fail([error(path, "parse.json", (e as Error).message)]);
  }
}

/** Parse a JSON file and validate it against a named schema. */
export function parseJson<K extends SchemaName>(
  name: K,
  text: string,
  path: string,
): ParseResult<EntityOf<K>> {
  const raw = parseJsonValue(text, path);
  if (!raw.ok) return fail(raw.diagnostics);
  const result = validate(name, raw.value, path);
  return result.ok ? finish(result.value, []) : fail(result.diagnostics);
}

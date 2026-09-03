import type { Bands } from "../bands.js";
import type { ParseResult } from "./result.js";
import { parseYaml } from "./yaml.js";

/** `bands.yaml` → validated control bands. */
export function parseBands(text: string, path: string): ParseResult<Bands> {
  return parseYaml("bands", text, path);
}

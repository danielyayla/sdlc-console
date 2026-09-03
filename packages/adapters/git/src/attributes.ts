import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MERGE_UNION_LINE = "sdlc/**/log.jsonl merge=union";

/** Ensure `.gitattributes` carries the union merge driver for ledgers. Idempotent; returns true when it wrote. */
export function installMergeUnion(dir: string): boolean {
  const path = join(dir, ".gitattributes");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.split(/\r?\n/).some((l) => l.trim() === MERGE_UNION_LINE)) return false;
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${sep}${MERGE_UNION_LINE}\n`, "utf8");
  return true;
}

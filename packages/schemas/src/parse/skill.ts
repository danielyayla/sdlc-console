import { parseFrontMatter } from "./frontmatter.js";
import { error, fail, finish, type ParseResult } from "./result.js";

/** `.claude/skills/<name>/SKILL.md` front-matter plus the console's optional governance keys. */
export interface ParsedSkill {
  name: string;
  /** Claude Code's `description` doubles as the trigger. */
  trigger: string;
  owner: string | null;
  /** Hook name that enforces this skill, or null when it is advisory only. */
  backedBy: string | null;
  mustHold: boolean;
  body: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function parseSkill(text: string, path: string, dirName?: string): ParseResult<ParsedSkill> {
  const split = parseFrontMatter(text, path);
  if (!split.ok || split.value === null) return fail(split.diagnostics);
  const d = split.value.data;
  const diagnostics = [...split.diagnostics];
  const name = str(d["name"]) ?? dirName ?? null;
  const trigger = str(d["description"]);
  if (!name) diagnostics.push(error(path, "skill.name.missing", "SKILL.md needs a name", 1));
  if (!trigger) diagnostics.push(error(path, "skill.description.missing", "SKILL.md needs a description (its trigger)", 1));
  if (!name || !trigger) return fail(diagnostics);
  const mustHoldRaw = d["must_hold"] ?? d["must-hold"] ?? d["mustHold"];
  return finish(
    {
      name,
      trigger,
      owner: str(d["owner"]),
      backedBy: str(d["backed_by"] ?? d["backed-by"] ?? d["backedBy"]),
      mustHold: mustHoldRaw === true || mustHoldRaw === "true",
      body: split.value.body,
    },
    diagnostics,
  );
}

import { parseFrontMatter } from "./frontmatter.js";
import { error, fail, finish, type ParseResult } from "./result.js";

/** `.claude/agents/<name>.md` front-matter. */
export interface ParsedAgent {
  name: string;
  description: string;
  tools: string[];
  model: string | null;
  body: string;
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

export function parseAgent(text: string, path: string, fileStem?: string): ParseResult<ParsedAgent> {
  const split = parseFrontMatter(text, path);
  if (!split.ok || split.value === null) return fail(split.diagnostics);
  const d = split.value.data;
  const diagnostics = [...split.diagnostics];
  const name = typeof d["name"] === "string" && d["name"].trim() !== "" ? d["name"].trim() : (fileStem ?? null);
  const description = typeof d["description"] === "string" ? d["description"].trim() : "";
  if (!name) diagnostics.push(error(path, "agent.name.missing", "agent needs a name", 1));
  if (description === "") diagnostics.push(error(path, "agent.description.missing", "agent needs a description", 1));
  if (!name || description === "") return fail(diagnostics);
  return finish(
    {
      name,
      description,
      tools: toList(d["tools"]),
      model: typeof d["model"] === "string" ? d["model"] : null,
      body: split.value.body,
    },
    diagnostics,
  );
}

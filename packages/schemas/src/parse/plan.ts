import { parseArtifact, type ParsedArtifact } from "./artifact.js";
import { findSection } from "./markdown.js";
import { fail, finish, warning, type ParseResult } from "./result.js";

export interface PlanFile {
  path: string;
  isNew: boolean;
  line: number;
}

export interface ParsedPlan extends ParsedArtifact<"plan"> {
  /** Machine-readable "Files that change" list; globs are kept as written. */
  files: PlanFile[];
  /** Numbered steps under "Order of work". */
  order: string[];
  acceptanceLine: string;
  /** `<sha>` from the `# Plan: … (from spec.md <sha>)` heading, when present. */
  specShaFromTitle: string | null;
}

const SKIP = /^\s*<.*>\s*$/;

/** Parse one line of the files list: `- path (new)`, `path`, `` `path` (new, generated) ``. */
export function parseFileLine(line: string): { path: string; isNew: boolean } | null {
  const stripped = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/`/g, "").trim();
  if (stripped === "" || SKIP.test(stripped)) return null;
  const m = /^(\S+)(?:\s+\(([^)]*)\))?\s*(?:[—–-].*)?$/.exec(stripped);
  if (!m?.[1]) return null;
  return { path: m[1], isNew: /\bnew\b/i.test(m[2] ?? "") };
}

/** Parse `plan.md` fully: artifact completeness plus the machine-readable parts. */
export function parsePlan(text: string, path: string): ParseResult<ParsedPlan> {
  const base = parseArtifact("plan", text, path);
  if (!base.ok || base.value === null) return fail(base.diagnostics);
  const diagnostics = [...base.diagnostics];

  const files: PlanFile[] = [];
  const filesSection = findSection(base.value.sections, "Files that change");
  if (filesSection) {
    filesSection.content.split(/\r?\n/).forEach((raw, i) => {
      const parsed = parseFileLine(raw);
      if (parsed) files.push({ ...parsed, line: filesSection.line + 1 + i });
    });
  }
  if (files.length === 0) {
    diagnostics.push(warning(path, "plan.files.empty", '"Files that change" lists no files', filesSection?.line));
  }

  const order: string[] = [];
  const orderSection = findSection(base.value.sections, "Order of work");
  if (orderSection) {
    for (const raw of orderSection.content.split(/\r?\n/)) {
      const m = /^\s*\d+[.)]\s+(.*\S)\s*$/.exec(raw);
      if (m?.[1]) order.push(m[1]);
    }
  }

  const titleMatch = base.value.title ? /\(from spec\.md\s+([0-9a-f]{7,64})\)/i.exec(base.value.title) : null;

  return finish(
    {
      ...base.value,
      files,
      order,
      acceptanceLine: base.value.frontMatter.acceptance_line,
      specShaFromTitle: titleMatch?.[1] ?? null,
    },
    diagnostics,
  );
}

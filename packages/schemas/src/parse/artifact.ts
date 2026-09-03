import type {
  IncidentFrontMatter,
  IntentFrontMatter,
  PlanFrontMatter,
  SpecFrontMatter,
} from "../frontmatter.js";
import { validate, type Diagnostic } from "../validate.js";
import { parseFrontMatter } from "./frontmatter.js";
import { findSection, isPlaceholderContent, outline, type Section } from "./markdown.js";
import { error, fail, finish, warning, type ParseResult } from "./result.js";

export type ArtifactKind = "intent" | "spec" | "plan" | "incident";

/** Required `##` sections per template under `sdlc/templates/`. */
export const REQUIRED_SECTIONS: Record<ArtifactKind, readonly string[]> = {
  intent: ["Problem", "Proposed outcome", "Affected users and systems", "Constraints", "Open questions"],
  spec: ["Requirements", "Design", "Areas of concern", "Open questions carried forward"],
  plan: ["Files that change", "Order of work", "Risks", "Proof"],
  incident: ["Anomaly and evidence", "Proposed outcome", "Affected systems", "Open questions"],
};

type FrontMatterFor<K extends ArtifactKind> = K extends "intent"
  ? IntentFrontMatter
  : K extends "spec"
    ? SpecFrontMatter
    : K extends "plan"
      ? PlanFrontMatter
      : IncidentFrontMatter;

export interface ParsedArtifact<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  frontMatter: FrontMatterFor<K>;
  title: string | null;
  body: string;
  sections: Section[];
  /** Required sections that are absent. Blocking for gate open. */
  missingSections: string[];
  /** Required sections present but blank or placeholder-only. */
  emptySections: string[];
  /** True when nothing is missing or empty. */
  complete: boolean;
}

const SCHEMA_FOR: Record<ArtifactKind, "intent-frontmatter" | "spec-frontmatter" | "plan-frontmatter" | "incident-frontmatter"> = {
  intent: "intent-frontmatter",
  spec: "spec-frontmatter",
  plan: "plan-frontmatter",
  incident: "incident-frontmatter",
};

/**
 * Parse a markdown artifact: validated front-matter plus the section outline
 * and completeness against its template. Front-matter errors are blocking;
 * empty sections are warnings so a draft can still be inspected.
 */
export function parseArtifact<K extends ArtifactKind>(
  kind: K,
  text: string,
  path: string,
): ParseResult<ParsedArtifact<K>> {
  const split = parseFrontMatter(text, path);
  if (!split.ok || split.value === null) return fail(split.diagnostics);
  const diagnostics: Diagnostic[] = [];
  if (!split.value.hasFrontMatter) {
    diagnostics.push(error(path, "artifact.frontmatter.missing", `${kind}.md has no front-matter`, 1));
  }
  const fm = validate(SCHEMA_FOR[kind], split.value.data, path);
  if (!fm.ok) diagnostics.push(...fm.diagnostics);

  const md = outline(split.value.body, split.value.bodyLine);
  const missingSections: string[] = [];
  const emptySections: string[] = [];
  for (const name of REQUIRED_SECTIONS[kind]) {
    const section = findSection(md.sections, name);
    if (!section) {
      missingSections.push(name);
      diagnostics.push(error(path, "artifact.section.missing", `missing section "## ${name}"`));
    } else if (isPlaceholderContent(section.content)) {
      emptySections.push(name);
      diagnostics.push(warning(path, "artifact.section.empty", `section "## ${name}" is empty`, section.line));
    }
  }
  if (!fm.ok) return fail(diagnostics);
  return finish(
    {
      kind,
      frontMatter: fm.value as FrontMatterFor<K>,
      title: md.title,
      body: split.value.body,
      sections: md.sections,
      missingSections,
      emptySections,
      complete: missingSections.length === 0 && emptySections.length === 0,
    },
    diagnostics,
  );
}

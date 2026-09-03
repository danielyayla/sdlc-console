import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArtifact, parseFileLine, parseFrontMatter, parsePlan, outline } from "../src/index.js";
import { SHA, TS } from "./samples.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, "utf8");

const intent = `---
id: CHG-0042
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: ${TS}
status: draft
schema: 1
---
# Intent: Invoice CSV export

## Problem
Finance cannot export invoices.

## Proposed outcome
A CSV download per month.

## Affected users and systems
Finance team; invoicing service.

## Constraints
No PII beyond invoice ids.

## Open questions
<none yet>
`;

describe("parseFrontMatter", () => {
  it("splits data and body and reports the body's first line", () => {
    const r = parseFrontMatter(intent, "intent.md");
    expect(r.ok).toBe(true);
    expect(r.value?.data["artifact"]).toBe("intent");
    expect(r.value?.bodyLine).toBe(10);
    expect(r.value?.body.startsWith("# Intent")).toBe(true);
  });
  it("treats a file without front-matter as an empty data object", () => {
    const r = parseFrontMatter("# Just markdown\n", "x.md");
    expect(r.ok).toBe(true);
    expect(r.value?.hasFrontMatter).toBe(false);
    expect(r.value?.data).toEqual({});
  });
  it("never throws on broken YAML front-matter", () => {
    const r = parseFrontMatter("---\nid: [oops\n---\nbody\n", "x.md");
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.rule).toBe("parse.frontmatter");
  });
});

describe("outline", () => {
  it("captures title and sections with line numbers and ignores headings inside fences", () => {
    const md = "# T\n\n## A\ntext\n```\n## not a heading\n```\n## B\n";
    const o = outline(md, 10);
    expect(o.title).toBe("T");
    expect(o.sections.map((s) => [s.name, s.line])).toEqual([
      ["A", 12],
      ["B", 17],
    ]);
    expect(o.sections[0]?.content).toContain("## not a heading");
  });
});

describe("parseArtifact", () => {
  it("accepts a complete intent and flags the placeholder-only section as empty", () => {
    const r = parseArtifact("intent", intent, "sdlc/changes/CHG-0042/intent.md");
    expect(r.ok).toBe(true);
    expect(r.value?.title).toBe("Intent: Invoice CSV export");
    expect(r.value?.missingSections).toEqual([]);
    expect(r.value?.emptySections).toEqual(["Open questions"]);
    expect(r.value?.complete).toBe(false);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", rule: "artifact.section.empty", line: 24 }),
    ]);
  });

  it("reports missing required sections as errors", () => {
    const r = parseArtifact("intent", intent.replace("## Constraints\nNo PII beyond invoice ids.\n", ""), "intent.md");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.rule)).toContain("artifact.section.missing");
    expect(r.value).toBeNull();
  });

  it("rejects front-matter that fails its schema", () => {
    const r = parseArtifact("intent", intent.replace("artifact: intent", "artifact: spec"), "intent.md");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.pointer === "/artifact")).toBe(true);
  });

  it("the templates list every required section; only plan's front-matter is valid unfilled", () => {
    for (const kind of ["intent", "spec", "plan", "incident"] as const) {
      const r = parseArtifact(kind, read(`sdlc/templates/${kind}.md`), `sdlc/templates/${kind}.md`);
      expect(r.diagnostics.some((d) => d.rule === "artifact.section.missing")).toBe(false);
      expect(r.ok).toBe(kind === "plan");
      if (kind === "plan") expect(r.value?.emptySections).toEqual(["Files that change", "Order of work", "Risks", "Proof"]);
    }
  });
});

describe("parsePlan", () => {
  it("parses file lines in every accepted form", () => {
    expect(parseFileLine("- src/a.ts (new)")).toEqual({ path: "src/a.ts", isNew: true });
    expect(parseFileLine("src/b.ts")).toEqual({ path: "src/b.ts", isNew: false });
    expect(parseFileLine("`packages/x/json/*.schema.json` (new, generated)")).toEqual({
      path: "packages/x/json/*.schema.json",
      isNew: true,
    });
    expect(parseFileLine("3. docs/c.md — reason")).toEqual({ path: "docs/c.md", isNew: false });
    expect(parseFileLine("<one path per line>")).toBeNull();
    expect(parseFileLine("")).toBeNull();
  });

  it("parses this repo's CHG-0001 plan: files, order, acceptance line", () => {
    const r = parsePlan(read("sdlc/changes/CHG-0001/plan.md"), "sdlc/changes/CHG-0001/plan.md");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value?.files.length).toBeGreaterThan(30);
    expect(r.value?.files.find((f) => f.path === ".gitattributes")?.isNew).toBe(true);
    expect(r.value?.files.find((f) => f.path === ".gitignore")?.isNew).toBe(false);
    expect(r.value?.order.length).toBe(15);
    expect(r.value?.acceptanceLine).toMatch(/pnpm build/);
    expect(r.value?.frontMatter.spec_sha).toBeNull();
  });

  it("reads the spec sha from the title and warns on an empty file list", () => {
    const plan = `---
id: CHG-0042
artifact: plan
cycle: 1
spec_sha: ${SHA}
rev: 1
accepted_by:
accepted_at:
acceptance_line: "x"
schema: 1
---
# Plan: Export (from spec.md ${SHA.slice(0, 12)})

## Files that change
<one path per line>

## Order of work
1. a
2. b

## Risks
none

## Proof
tests
`;
    const r = parsePlan(plan, "plan.md");
    expect(r.ok).toBe(true);
    expect(r.value?.specShaFromTitle).toBe(SHA.slice(0, 12));
    expect(r.value?.files).toEqual([]);
    expect(r.diagnostics.map((d) => d.rule)).toEqual(
      expect.arrayContaining(["plan.files.empty", "artifact.section.empty"]),
    );
  });
});

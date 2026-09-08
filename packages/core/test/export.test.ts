import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seedTree } from "@sdlc/fixtures";
import { validate, type ChangeExport } from "@sdlc/schemas";
import { applyWritePlan, canonicalJson, deriveChange, exportChange, exportContentHash, loadRepo, loop, renderChangeExportMarkdown, sha256Hex, verifyChangeExport, withFiles, type Repo } from "../src/index.js";

const HEADER = { exportedAt: "2026-09-08T10:00:00Z", exportedBy: { id: "auditor@veri.example", name: "Ada Auditor" } };
const GOLDEN = fileURLToPath(new URL("./golden/CHG-0012.export.json", import.meta.url));

/** The seed after CHG-0012's loop closed: cycle 1 archived under `cycles/1/`, cycle 2 live at stage 1. */
function loopedSeed(): Repo {
  const before = loadRepo(seedTree());
  const files = before.changes.get("CHG-0012");
  if (!files) throw new Error("CHG-0012");
  let n = 0;
  const r = loop(before, deriveChange(before, files), { now: "2026-09-02T09:00:00Z", newId: () => `01J8Z6Q7Y2K3M4N5P6Q7R8S${(++n).toString(36).toUpperCase().padStart(3, "0")}`.replace(/[ILOU]/g, "X"), actor: { id: "po@veri.example" } });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return loadRepo(applyWritePlan(seedTree(), r.plan));
}

function exportOf(repo: Repo, id: string, commits?: Record<string, string>): ChangeExport {
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  const doc = exportChange(repo, deriveChange(repo, files), { ...HEADER, ...(commits ? { commits } : {}) });
  if (!doc) throw new Error("no export");
  return doc;
}

describe("sha256 (pure, for the export's content hash)", () => {
  it("matches node:crypto on empty, short, multi-block and non-ASCII input", () => {
    for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "ünïcödé → ✓ 日本語", JSON.stringify({ a: [1, 2, { b: null }] })]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("canonical JSON", () => {
  it("sorts keys at every level, drops undefined members and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([undefined, null, "x"])).toBe('[null,null,"x"]');
  });
});

describe("exportChange (3.3 compliance export)", () => {
  it("golden: the looped seed's CHG-0012 exports its archived cycle 1 and live cycle 2 exactly as recorded", () => {
    const doc = exportOf(loopedSeed(), "CHG-0012");
    mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as ChangeExport;
    expect(doc).toEqual(golden);
    expect(validate("change-export", doc).ok).toBe(true);

    expect(doc.change?.cycle).toBe(2);
    expect(doc.derived).toMatchObject({ stage: 1, valid: true, acceptedGates: [] });
    expect(doc.cycles.map((c) => [c.cycle, c.archived, c.dir])).toEqual([
      [1, true, "sdlc/changes/CHG-0012/cycles/1"],
      [2, false, "sdlc/changes/CHG-0012"],
    ]);
    const c1 = doc.cycles[0];
    const c2 = doc.cycles[1];
    if (!c1 || !c2) throw new Error("cycles");
    // the archived cycle keeps its artifacts with their blob shas, its PR, its run and its decisions
    expect(c1.artifacts.map((a) => a.name)).toEqual(["intent.md", "spec.md", "plan.md", "pr.yaml", "incident.md", "evals/final-round.json"]);
    expect(c1.artifacts.every((a) => /^[0-9a-f]{40}$/.test(a.sha))).toBe(true);
    expect(c1.artifacts.find((a) => a.name === "incident.md")?.frontMatter).toMatchObject({ artifact: "incident", cycle: 1 });
    expect(c1.decisions.map((d) => [d.gate, d.decision, d.by.id, d.by.role, d.source, d.commit])).toEqual([
      [1, "accepted", "po@veri.example", "po", "cli", null],
      [2, "accepted", "po@veri.example", "po", "cli", null],
      [3, "accepted", "eng@veri.example", "eng", "cli", null],
      [5, "accepted", "eng@veri.example", "eng", "cli", null],
      [6, "accepted", "po@veri.example", "po", "cli", null],
    ]);
    expect(c1.pr).toMatchObject({ provider: "local", mergeSha: "c2e4d0b3e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3", review: { session: "s-0012-review" } });
    expect(c1.runs.map((r) => [r.n, r.verdict])).toEqual([[1, "green"]]);
    expect(c1.deploy?.status).toBe("succeeded");
    expect(c1.merges.map((m) => m.mergeSha)).toEqual(["c2e4d0b3e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3"]);
    // the live cycle: the seeded intent, no decisions yet, no PR
    expect(c2.artifacts.map((a) => a.name)).toEqual(["intent.md"]);
    expect(c2.decisions).toEqual([]);
    expect(c2.pr).toBeNull();
    // the ledger travels verbatim and in order
    const files = loopedSeed().changes.get("CHG-0012");
    expect(doc.events).toEqual(files?.events);
    expect(doc.events.map((e) => e.cycle)).toEqual([...doc.events].map((e) => e.cycle).sort((a, b) => a - b));
    expect(doc.evalCases.map((e) => e.id)).toContain("INC-CHG-0012-1");
  });

  it("the content hash is sha256 over the canonical JSON without the hash, stable across runs, and verifiable", () => {
    const repo = loopedSeed();
    const a = exportOf(repo, "CHG-0012");
    const b = exportOf(loopedSeed(), "CHG-0012");
    expect(a.contentHash).toEqual(b.contentHash);
    expect(a.contentHash.value).toMatch(/^[0-9a-f]{64}$/);
    const { contentHash: _h, ...rest } = a;
    void _h;
    expect(a.contentHash.value).toBe(createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex"));
    expect(exportContentHash(a)).toBe(a.contentHash.value);
    expect(verifyChangeExport(a)).toBe(true);
    // a tampered decision breaks the hash
    const tampered = JSON.parse(JSON.stringify(a)) as ChangeExport;
    const d = tampered.cycles[0]?.decisions[0];
    if (d) d.by.id = "someone-else@veri.example";
    expect(verifyChangeExport(tampered)).toBe(false);
    // a different exporter or time is part of the document, so the hash moves with it
    const files = repo.changes.get("CHG-0012");
    if (!files) throw new Error("files");
    expect(exportChange(repo, deriveChange(repo, files), { ...HEADER, exportedAt: "2026-09-09T10:00:00Z" })?.contentHash.value).not.toBe(a.contentHash.value);
  });

  it("carries the decision commits the adapter resolved, and findings and artifact PRs from the ledger", () => {
    const repo = loadRepo(seedTree());
    const files = repo.changes.get("CHG-0012");
    if (!files) throw new Error("files");
    const accepted = files.events.filter((e) => e.event === "gate.accepted");
    const commits = Object.fromEntries(accepted.map((e, i) => [e.id, `${String(i + 1).repeat(7)}0000000000000000000000000000000000`.slice(0, 40)]));
    const doc = exportOf(repo, "CHG-0012", commits);
    expect(doc.cycles).toHaveLength(1);
    expect(doc.cycles[0]?.decisions.map((d) => d.commit)).toEqual(accepted.map((e) => commits[e.id]));
    const withFindings = repo.changes.get("CHG-0017");
    if (!withFindings) throw new Error("CHG-0017");
    const d17 = exportOf(repo, "CHG-0017");
    expect(d17.cycles[0]?.findings.length).toBe(withFindings.events.filter((e) => e.event === "review.finding").length);
    expect(validate("change-export", d17).ok).toBe(true);
  });

  it("exports an invalid change with its diagnostics and a null record when change.yaml is unreadable; null for a missing change", () => {
    const tree = withFiles(seedTree(), { "sdlc/changes/CHG-0099/change.yaml": "schema: 1\nid: CHG-0098\n", "sdlc/changes/CHG-0099/log.jsonl": "" });
    const repo = loadRepo(tree);
    const doc = exportOf(repo, "CHG-0099");
    expect(doc.change).toBeNull();
    expect(doc.derived.valid).toBe(false);
    expect(doc.derived.validationErrors.length).toBeGreaterThan(0);
    expect(validate("change-export", doc).ok).toBe(true);
    const files = repo.changes.get("CHG-0012");
    if (!files) throw new Error("files");
    const view = { ...deriveChange(repo, files), id: "CHG-0000" };
    expect(exportChange(repo, view, HEADER)).toBeNull();
  });

  it("renders the document as Markdown with the hash, the decisions table, the runs and the ledger verbatim", () => {
    const doc = exportOf(loopedSeed(), "CHG-0012");
    const md = renderChangeExportMarkdown(doc);
    expect(md).toContain("# Compliance export · CHG-0012 · Invoice PDF rendering");
    expect(md).toContain(`\`${doc.contentHash.value}\``);
    expect(md).toContain("## Cycle 1 (archived) · `sdlc/changes/CHG-0012/cycles/1`");
    expect(md).toContain("## Cycle 2 (live) · `sdlc/changes/CHG-0012`");
    expect(md).toContain("| 6 | accepted | po@veri.example | po | cli |");
    expect(md).toContain("| 1 | green |");
    expect(md).toContain(`## Ledger (${doc.events.length} events, verbatim)`);
    for (const e of doc.events) expect(md).toContain(JSON.stringify(e));
    expect(md).toContain("## sdlc/changes/CHG-0012/cycles/1/incident.md ·");
  });
});

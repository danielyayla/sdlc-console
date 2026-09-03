import { describe, expect, it } from "vitest";
import { ZERO_SHA, childDirs, configFingerprint, filesUnder, fingerprintMatches, loadRepo, treeFromRecord, withFiles } from "../src/index.js";
import { baseTree, withChange } from "./helpers.js";

describe("tree helpers", () => {
  it("lists child dirs and files under a prefix", () => {
    const t = treeFromRecord({ "a/b/c.txt": "1", "a/d.txt": "2", "e.txt": "3", "a/b/f/g.txt": "4" });
    expect(childDirs(t, "a")).toEqual(["b"]);
    expect(childDirs(t, "a/b")).toEqual(["f"]);
    expect(filesUnder(t, "a/b")).toEqual(["a/b/c.txt", "a/b/f/g.txt"]);
  });
  it("synthetic shas are 40 hex and change with content", () => {
    const t = treeFromRecord({ x: "one", y: "two" });
    expect(t.files.get("x")?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(t.files.get("x")?.sha).not.toBe(t.files.get("y")?.sha);
  });
});

describe("configFingerprint", () => {
  it("uses CLAUDE.md, settings.json and skill versions; model is recorded not matched", () => {
    const t = withFiles(baseTree(), { ".claude/skills/brand/SKILL.md": "---\nname: brand\ndescription: d\n---\n" });
    const fp = configFingerprint(t);
    expect(fp.claudeMdSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fp.skills).toEqual([{ name: "brand", version: expect.any(String) }]);
    expect(fingerprintMatches(fp, { ...fp, model: "claude-opus-5" })).toBe(true);
    expect(fingerprintMatches(fp, { ...fp, hooksSha: ZERO_SHA })).toBe(false);
    expect(fingerprintMatches(fp, { ...fp, skills: [] })).toBe(false);
  });
});

describe("loadRepo", () => {
  it("parses config, CLAUDE.md, settings and change directories with no diagnostics on a clean tree", () => {
    const repo = loadRepo(withChange(baseTree(), { id: "CHG-0001", intent: true }));
    expect(repo.diagnostics).toEqual([]);
    expect(repo.config.present).toBe(true);
    expect(repo.config.thresholds.autoFilesMax).toBe(3);
    expect(repo.config.thresholds.maxLoopRounds).toBe(5);
    expect(repo.verification?.commands.length).toBe(3);
    expect(repo.settings?.hooks.map((h) => h.name)).toEqual(["verify-before-done"]);
    expect([...repo.changes.keys()]).toEqual(["CHG-0001"]);
    expect(repo.changes.get("CHG-0001")?.present.intent).toBe(true);
  });

  it("applies defaults and warns when config and CLAUDE.md are missing", () => {
    const repo = loadRepo(treeFromRecord({}));
    expect(repo.config.present).toBe(false);
    expect(repo.config.defaultRole).toBe("po");
    expect(repo.config.thresholds.autoFilesMax).toBe(12);
    expect(repo.verification).toBeNull();
    expect(repo.diagnostics.map((d) => d.rule).sort()).toEqual(["claude-md.missing", "config.missing"]);
  });

  it("keeps a change with a broken change.yaml as an invalid entry", () => {
    const repo = loadRepo(withFiles(baseTree(), { "sdlc/changes/CHG-0009/change.yaml": "schema: 1\nid: CHG-0009\n" }));
    const files = repo.changes.get("CHG-0009");
    expect(files?.change).toBeNull();
    expect(files?.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("loads triage, findings, proposals, eval cases and runs", () => {
    const t = withFiles(baseTree(), {
      "sdlc/loop/triage/TRI-0042.md": "---\nschema: 1\nid: TRI-0042\ntier: 3σ\nsrc: metric:p95\ntitle: slow\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: open\n---\n# Intent: slow\n",
      "sdlc/security/findings/SEC-0118.yaml": "schema: 1\nid: SEC-0118\nscannerId: s\nsev: high\nconf: 0.9\nrepo: r\ntitle: t\ndesc: d\nstatus: new\n",
      "sdlc/proposals/PRP-0001.yaml": "schema: 1\nid: PRP-0001\ntype: claude-md-line\ntext: t\ncitations: [CHG-0001]\nstatus: open\ncreatedAt: 2026-09-03T10:00:00Z\n",
      "evals/cases/CASE-0001.json": JSON.stringify({ schema: 1, id: "CASE-0001", prompt: "p", checks: [{ name: "t", cmd: "pnpm test" }], source: { type: "manual" }, owner: "o", added: "2026-09-03T10:00:00Z", status: "active", paths: ["src/a.ts"] }),
      "evals/runs/RUN-0001.json": JSON.stringify({ schema: 1, id: "RUN-0001", trigger: "manual", configRef: { claudeMdSha: ZERO_SHA, skills: [], hooksSha: ZERO_SHA, model: "m" }, results: [], passRate: 1, threshold: 0.9, verdict: "pass", startedAt: "2026-09-03T10:00:00Z" }),
    });
    const repo = loadRepo(t);
    expect(repo.diagnostics).toEqual([]);
    expect(repo.triage[0]?.data.id).toBe("TRI-0042");
    expect(repo.triage[0]?.body).toContain("# Intent: slow");
    expect(repo.findings[0]?.id).toBe("SEC-0118");
    expect(repo.proposals[0]?.id).toBe("PRP-0001");
    expect(repo.evalCases[0]?.id).toBe("CASE-0001");
    expect(repo.evalRuns[0]?.id).toBe("RUN-0001");
  });

  it("a bad log line does not hide the good ones", () => {
    const t = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const withLog = withFiles(t, { "sdlc/changes/CHG-0001/log.jsonl": '{"nope":1}\n' });
    const files = loadRepo(withLog).changes.get("CHG-0001");
    expect(files?.events).toEqual([]);
    expect(files?.diagnostics.some((d) => d.line === 1)).toBe(true);
  });
});

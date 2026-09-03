import { beforeEach, describe, expect, it } from "vitest";
import { check, deriveChange, loadRepo } from "../src/index.js";
import { ENG, SHA, acceptedThrough, baseTree, ev, filesOf, resetSeq, withChange } from "./helpers.js";

beforeEach(resetSeq);

describe("planSync (acceptance i)", () => {
  const plan = ["src/a.ts", "src/b.ts", "docs/**/*.md"];
  it("allows files in the plan, globs included, and sdlc/ ledger files", () => {
    expect(check.planSync(["src/a.ts", "docs/x/y.md", "sdlc/changes/CHG-0001/log.jsonl"], plan, "sdlc/changes/CHG-0001/plan.md").allowed).toBe(true);
  });
  it("blocks files outside the plan with the offending list", () => {
    const r = check.planSync(["src/a.ts", "src/c.ts"], plan, "sdlc/changes/CHG-0001/plan.md");
    expect(r.allowed).toBe(false);
    expect(r.offending).toEqual(["src/c.ts"]);
    expect(r.reason).toContain("src/c.ts");
  });
  it("allows anything when plan.md changes in the same commit", () => {
    expect(check.planSync(["src/c.ts", "sdlc/changes/CHG-0001/plan.md"], plan, "sdlc/changes/CHG-0001/plan.md").allowed).toBe(true);
  });
});

describe("testFreeze (acceptance k)", () => {
  const frozenTree = (events = acceptedThrough([1, 2, 3])) => {
    const t = withChange(baseTree(), { id: "CHG-0001", kind: "fix", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events });
    const y = t.files.get("sdlc/changes/CHG-0001/change.yaml");
    const content = (y?.content ?? "").replace("repro: null", `repro: { state: committed, testPath: test/a.test.ts, failureReason: r, sha: ${SHA} }`);
    const files = new Map(t.files);
    files.set("sdlc/changes/CHG-0001/change.yaml", { content, sha: "a".repeat(40) });
    return { ...t, files };
  };
  it("blocks edits under test globs while the repro is committed at stage 4", () => {
    const repo = loadRepo(frozenTree());
    const files = filesOf(repo, "CHG-0001");
    const view = deriveChange(repo, files);
    expect(view.stage).toBe(4);
    expect(check.testFreeze("test/b.test.ts", view, files, ["test/**/*.test.ts"]).allowed).toBe(false);
    expect(check.testFreeze("src/a.ts", view, files, ["test/**/*.test.ts"]).allowed).toBe(true);
  });
  it("honours a single lift for the named file", () => {
    const repo = loadRepo(frozenTree([...acceptedThrough([1, 2, 3]), ev("freeze.lifted", ENG, { path: "test/b.test.ts", reason: "fixture rename" })]));
    const files = filesOf(repo, "CHG-0001");
    const view = deriveChange(repo, files);
    expect(check.testFreeze("test/b.test.ts", view, files, ["test/**"]).allowed).toBe(true);
    expect(check.testFreeze("test/c.test.ts", view, files, ["test/**"]).allowed).toBe(false);
  });
  it("does nothing when no repro is committed", () => {
    const repo = loadRepo(withChange(baseTree(), { id: "CHG-0001", intent: true }));
    const files = filesOf(repo, "CHG-0001");
    expect(check.testFreeze("test/x.ts", deriveChange(repo, files), files, ["test/**"]).allowed).toBe(true);
  });
});

describe("verifyBeforeDone (acceptance j)", () => {
  it("blocks with no round, a red result, or missing output; allows a green round with output", () => {
    expect(check.verifyBeforeDone([]).allowed).toBe(false);
    const red = check.verifyBeforeDone([{ n: 3, results: [{ name: "build", pass: true, outputExcerpt: "ok" }, { name: "test", pass: false, outputExcerpt: "2 failing" }] }]);
    expect(red.allowed).toBe(false);
    expect(red.reason).toContain("test red");
    expect(check.verifyBeforeDone([{ n: 1, results: [{ name: "test", pass: true, outputExcerpt: "" }] }]).allowed).toBe(false);
    expect(check.verifyBeforeDone([{ n: 1, results: [{ name: "test", pass: false, outputExcerpt: "x" }] }, { n: 2, results: [{ name: "test", pass: true, outputExcerpt: "5 passed" }] }]).allowed).toBe(true);
  });
});

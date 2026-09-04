import { beforeEach, describe, expect, it } from "vitest";
import { accept, applyWritePlan, confirmRepro, dismissAutoFinding, liftFreeze, loadRepo, rejectRepro, validateTree, withFiles, type Tree } from "../src/index.js";
import { AGENT, ENG, PO, SHA, acceptedThrough, baseTree, changeFiles, ev, filesOf, resetSeq, viewOf, withChange } from "./helpers.js";

let ids = 0;
/** Decisions land after the seed's events (the helpers spread those over the hour before). */
const NOW = "2026-09-03T12:00:00Z";
// a prefix of its own: the helpers mint ids under 01J8Z6Q7Y2K3M4N5P6Q7R8…, and the ledger keeps the first event per id
const ctx = { now: NOW, newId: () => `01J8Z6Q7Y2K3M4N5P6Q7RR${(++ids).toString(36).toUpperCase().padStart(4, "0")}`.replace(/[ILOU]/g, "X"), actor: { id: "eng@example.com" } };
const TEST = "test/a.test.ts";
const REPRO_SHA = "e4a6f2d5a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5";

/** A fix at stage 4 (plan accepted), optionally with its repro test already confirmed. */
function fixAtStage4(extraEvents = [] as ReturnType<typeof ev>[]): Tree {
  return withChange(baseTree(), { id: "CHG-0001", kind: "fix", intent: true, spec: true, plan: { files: ["src/a.ts", `${TEST} (new)`], accepted: true }, events: [...acceptedThrough([1, 2, 3]), ...extraEvents] });
}

function confirmed(tree: Tree): Tree {
  const { repo, view } = viewOf(tree, "CHG-0001");
  const r = confirmRepro(repo, view, { testPath: TEST, failureReason: "expected 4 rows, received 3", sha: REPRO_SHA, output: "AssertionError: expected 4 rows, received 3" }, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return applyWritePlan(repo.tree, r.plan);
}

beforeEach(resetSeq);

describe("repro reject (2.7, spec 5B.3 'Wrong failure — send back')", () => {
  it("records repro.rejected by the engineer with the reason; refused once the repro is committed, by a PO, or without a reason", () => {
    const tree = fixAtStage4([ev("repro.failed", AGENT, { testPath: TEST, failureReason: "expected 200, received 500" })]);
    const { repo, view } = viewOf(tree, "CHG-0001");
    expect(view.reproRejection).toBeNull();
    const r = rejectRepro(repo, view, { testPath: TEST, reason: "asserts the wrong row" }, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.plan.files).toEqual([]);
    expect(r.plan.commitMessage).toBe("sdlc(CHG-0001): repro test test/a.test.ts sent back — asserts the wrong row");
    expect(r.plan.events[0]?.event).toMatchObject({ event: "repro.rejected", actor: { type: "human", id: "eng@example.com", role: "eng" }, data: { testPath: TEST, reason: "asserts the wrong row" } });
    const after = viewOf(applyWritePlan(repo.tree, r.plan), "CHG-0001");
    expect(after.view.reproRejection).toEqual({ testPath: TEST, reason: "asserts the wrong row", at: expect.any(String) as string });
    expect(after.view.activity[0]?.text).toBe("sent back repro test test/a.test.ts: asserts the wrong row");
    expect(validateTree(after.repo).blocking).toBe(false);
    // the session answers with a new failing test: the rejection is history
    const answered = withFiles(after.repo.tree, changeFiles(after.repo.tree, { id: "CHG-0001", kind: "fix", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: [...filesOf(after.repo, "CHG-0001").events, ev("repro.failed", AGENT, { testPath: TEST, failureReason: "expected 4 rows, received 3" }, 1, "2026-09-03T13:00:00Z")] }));
    expect(viewOf(answered, "CHG-0001").view.reproRejection).toBeNull();

    const po = rejectRepro(repo, view, { testPath: TEST, reason: "x" }, { ...ctx, actor: { id: "po@example.com" } });
    expect(po.ok).toBe(false);
    if (!po.ok) expect(po.diagnostics[0]?.rule).toBe("repro.not-engineer");
    const blank = rejectRepro(repo, view, { testPath: TEST, reason: "  " }, ctx);
    if (!blank.ok) expect(blank.diagnostics[0]?.rule).toBe("repro.reason-missing");
    const done = viewOf(confirmed(tree), "CHG-0001");
    const late = rejectRepro(done.repo, done.view, { testPath: TEST, reason: "x" }, ctx);
    if (!late.ok) expect(late.diagnostics[0]?.rule).toBe("repro.already");
    expect(late.ok).toBe(false);
  });
});

describe("freeze lift once (2.7, FR-22)", () => {
  it("one freeze.lifted per file per change; the second is refused and a duplicate on the ledger blocks validation", () => {
    const tree = confirmed(fixAtStage4());
    const { repo, view } = viewOf(tree, "CHG-0001");
    expect(view.repro?.state).toBe("committed");
    expect(view.freezeLifts).toEqual([]);
    const r = liftFreeze(repo, view, { path: "test/fixtures/rows.json", reason: "fixture needs a zero-total row" }, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.plan.commitMessage).toBe("sdlc(CHG-0001): lift test freeze once for test/fixtures/rows.json");
    expect(r.plan.events[0]?.event).toMatchObject({ event: "freeze.lifted", actor: { type: "human", id: "eng@example.com", role: "eng" }, data: { path: "test/fixtures/rows.json", reason: "fixture needs a zero-total row" } });
    const after = viewOf(applyWritePlan(repo.tree, r.plan), "CHG-0001");
    expect(after.view.freezeLifts).toEqual([{ path: "test/fixtures/rows.json", reason: "fixture needs a zero-total row", by: "eng@example.com", at: expect.any(String) as string }]);
    expect(validateTree(after.repo).blocking).toBe(false);
    const again = liftFreeze(after.repo, after.view, { path: "test/fixtures/rows.json", reason: "again" }, ctx);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.diagnostics[0]?.rule).toBe("freeze.already-lifted");
    // a second file is its own lift
    expect(liftFreeze(after.repo, after.view, { path: "test/other.test.ts", reason: "y" }, ctx).ok).toBe(true);
    // nobody but an engineer, nothing without an active freeze
    const po = liftFreeze(after.repo, after.view, { path: "test/z.ts", reason: "y" }, { ...ctx, actor: { id: "po@example.com" } });
    if (!po.ok) expect(po.diagnostics[0]?.rule).toBe("freeze.not-engineer");
    const unfrozen = viewOf(fixAtStage4(), "CHG-0001");
    const none = liftFreeze(unfrozen.repo, unfrozen.view, { path: "test/z.ts", reason: "y" }, ctx);
    if (!none.ok) expect(none.diagnostics[0]?.rule).toBe("freeze.not-active");

    // a ledger carrying the same lift twice is not a decision the validator accepts
    const twice = fixAtStage4([ev("freeze.lifted", ENG, { path: "test/x.ts", reason: "a" }), ev("freeze.lifted", ENG, { path: "test/x.ts", reason: "b" })]);
    const report = validateTree(loadRepo(twice));
    expect(report.diagnostics.find((d) => d.rule === "freeze.lifted-twice")).toMatchObject({ blocking: true, changeId: "CHG-0001" });
    expect(report.blocking).toBe(true);
  });
});

describe("test-freeze fallback auto-finding and the repro proof at gate 5 (2.7)", () => {
  const prYaml = (extra: string) => `schema: 1\nprovider: local\nbranch: CHG-0001/work\nbaseBranch: main\nheadSha: ${SHA}\nopenedAt: 2026-09-03T12:00:00Z\nreviewers: []\nchecks:\n  - name: evidence\n    verdict: pass\n${extra}planMatches: true\n`;
  const atGate5 = (extra: string, autoFindings = ""): Tree => {
    const tree = baseTree();
    const files = changeFiles(tree, { id: "CHG-0001", kind: "fix", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], events: acceptedThrough([1, 2, 3]) });
    files["sdlc/changes/CHG-0001/pr.yaml"] = prYaml(extra) + autoFindings;
    return withFiles(tree, files);
  };
  const mergeCtx = { ...ctx, mergeSha: SHA };

  it("an undismissed auto-finding refuses the console's merge; dismissing it with a reason (engineer, logged) unblocks it; a merge done on the code host is recorded regardless", () => {
    const finding = "autoFindings:\n  - rule: test-freeze\n    path: test/b.test.ts\n    title: diff touches a test file during a fix\n    detail: test/b.test.ts changed after the repro commit e4a6f2d without a freeze lift\n";
    const { repo, view } = viewOf(atGate5("  - name: repro\n    verdict: pass\n", finding), "CHG-0001");
    expect(view.stage).toBe(5);
    expect(view.gate?.s).toBe(5);
    const refused = accept(repo, view, 5, mergeCtx);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.diagnostics[0]).toMatchObject({ rule: "merge.auto-finding", message: expect.stringContaining("diff touches a test file during a fix: test/b.test.ts") as string });
    // the code host already merged: the console records what happened
    expect(accept(repo, view, 5, { ...mergeCtx, source: "pr.merge" }).ok).toBe(true);

    const nope = dismissAutoFinding(repo, view, { path: "test/nope.ts", reason: "x" }, ctx);
    if (!nope.ok) expect(nope.diagnostics[0]?.rule).toBe("finding.missing");
    const blank = dismissAutoFinding(repo, view, { path: "test/b.test.ts", reason: " " }, ctx);
    if (!blank.ok) expect(blank.diagnostics[0]?.rule).toBe("dismissal.reason-missing");
    const po = dismissAutoFinding(repo, view, { path: "test/b.test.ts", reason: "x" }, { ...ctx, actor: { id: "po@example.com" } });
    if (!po.ok) expect(po.diagnostics[0]?.rule).toBe("finding.not-engineer");
    const d = dismissAutoFinding(repo, view, { path: "test/b.test.ts", reason: "I edited the fixture myself" }, ctx);
    if (!d.ok) throw new Error(JSON.stringify(d.diagnostics));
    expect(d.plan.commitMessage).toBe("sdlc(CHG-0001): dismiss auto-finding on test/b.test.ts — I edited the fixture myself");
    expect(d.plan.events[0]?.event).toMatchObject({ event: "note", actor: { type: "human", id: "eng@example.com" }, data: { text: 'dismissed auto-finding "diff touches a test file during a fix" on test/b.test.ts: I edited the fixture myself' } });
    const after = viewOf(applyWritePlan(repo.tree, d.plan), "CHG-0001");
    expect(after.view.pr?.autoFindings?.[0]?.dismissal).toEqual({ by: "eng@example.com", reason: "I edited the fixture myself", at: NOW });
    expect(validateTree(after.repo).blocking).toBe(false);
    const merged = accept(after.repo, after.view, 5, mergeCtx);
    expect(merged.ok).toBe(true);
    // dismissing twice: nothing open
    const twice = dismissAutoFinding(after.repo, after.view, { path: "test/b.test.ts", reason: "again" }, ctx);
    expect(twice.ok).toBe(false);
  });

  it("a red repro check refuses the merge of a fix; a feature ignores it", () => {
    const red = viewOf(atGate5("  - name: repro\n    verdict: fail\n    summary: repro test test/a.test.ts committed e4a6f2d before fix · modified after the repro commit without a lift · passing now\n"), "CHG-0001");
    const r = accept(red.repo, red.view, 5, mergeCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]).toMatchObject({ rule: "merge.repro-red", message: expect.stringContaining("modified after the repro commit") as string });
    expect(red.view.pr?.checks[1]?.summary).toContain("committed e4a6f2d before fix");
    const green = viewOf(atGate5("  - name: repro\n    verdict: pass\n"), "CHG-0001");
    expect(accept(green.repo, green.view, 5, mergeCtx).ok).toBe(true);
    void PO;
  });
});

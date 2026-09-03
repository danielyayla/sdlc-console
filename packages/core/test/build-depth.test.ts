import { beforeEach, describe, expect, it } from "vitest";
import { applyWritePlan, isDowngrade, loadRepo, overrideMode, resolveConfig, uiPaths, validateTree, verificationTerm, withFiles, type Tree } from "../src/index.js";
import { ENG, PO, SHA, TS, acceptedThrough, baseTree, changeFiles, ev, resetSeq, viewOf, withChange } from "./helpers.js";

const CLAUDE = (verify: string) => `# P\n\n## Verifying your work\n${verify}`;
const STANDARD = "- Build: `pnpm build`\n- Test: `pnpm test` (all green)\n- Lint: `pnpm lint`\n- Test files: `test/**/*.test.ts`\n";

/** A routine change at stage 4 with the given plan files, over a CLAUDE.md variant. */
function stage4(files: string[], verify = STANDARD, extra: Record<string, string> = {}): Tree {
  const tree = withFiles(baseTree(), { "CLAUDE.md": CLAUDE(verify), ...extra });
  return withChange(tree, { id: "CHG-0001", intent: true, spec: true, plan: { files, accepted: true }, events: acceptedThrough([1, 2, 3]) });
}

beforeEach(resetSeq);

describe("verification term (2.6, FR-34 / spec 5B.1)", () => {
  it("holds for a runnable loop: single-target commands, a test target, and no UI work without a visual tool", () => {
    const { view } = viewOf(stage4(["src/a.ts", "src/b.ts"]), "CHG-0001");
    const term = view.autoEligible.terms.find((t) => t.name === "verification block present");
    expect(term).toEqual({ name: "verification block present", ok: true, detail: "3 single-target commands in CLAUDE.md, test target present" });
    expect(view.autoEligible.value).toBe(true);
    expect(view.visual).toEqual({ uiPaths: [], tool: null, mock: null, warning: null });
  });

  it("fails on a chained command (wrap in one target), on a missing test target, and on UI paths without a Visual: line", () => {
    const chained = viewOf(stage4(["src/a.ts"], "- Build: `pnpm build`\n- Test: `pnpm build && pnpm test`\n- Test files: `test/**/*.test.ts`\n"), "CHG-0001").view;
    expect(chained.autoEligible.value).toBe(false);
    expect(chained.autoEligible.terms.find((t) => t.name === "verification block present")).toMatchObject({ ok: false, detail: "test chains commands — wrap in one target" });

    const noTest = viewOf(stage4(["src/a.ts"], "- Build: `pnpm build`\n- Lint: `pnpm lint`\n- Test files: `test/**/*.test.ts`\n"), "CHG-0001").view;
    expect(noTest.autoEligible.terms.find((t) => t.name === "verification block present")).toMatchObject({ ok: false, detail: "no test target in CLAUDE.md — the loop cannot tell red from green" });
    expect(noTest.autoEligible.terms.find((t) => t.name === "eval coverage for paths")).toMatchObject({ ok: false, detail: "no active eval case for planned paths and no test target" });

    const ui = viewOf(stage4(["web/src/App.tsx", "src/api.ts"]), "CHG-0001").view;
    expect(uiPaths(["web/src/App.tsx", "src/api.ts", "styles/main.css", "docs/x.md"])).toEqual(["web/src/App.tsx", "styles/main.css"]);
    expect(ui.visual).toEqual({ uiPaths: ["web/src/App.tsx"], tool: null, mock: null, warning: "UI work without a visual check — 1 UI path in plan and no Visual: line in CLAUDE.md" });
    expect(ui.autoEligible.value).toBe(false);
    expect(ui.autoEligible.terms.find((t) => t.name === "verification block present")).toMatchObject({ ok: false, detail: "UI work without a visual check — 1 UI path in plan and no Visual: line in CLAUDE.md" });

    const withVisual = viewOf(stage4(["web/src/App.tsx"], `${STANDARD}- Visual: \`npx playwright screenshot http://localhost:5173 shot.png\`\n`), "CHG-0001").view;
    expect(withVisual.visual.tool).toBe("screenshot-cli");
    expect(withVisual.visual.warning).toBeNull();
    expect(withVisual.autoEligible.value).toBe(true);
    expect(withVisual.autoEligible.terms.find((t) => t.name === "verification block present")?.detail).toBe("4 single-target commands in CLAUDE.md, test target present, visual tool screenshot-cli for 1 UI path");

    expect(verificationTerm(null, ["src/a.ts"])).toMatchObject({ ok: false, detail: "no feedback loop — set up verification in CLAUDE.md" });
  });

  it("lenient coverage needs a test target and test globs; the design mock is the first image under design/", () => {
    const noGlobs = viewOf(stage4(["src/a.ts"], "- Build: `pnpm build`\n- Test: `pnpm test`\n- Lint: `pnpm lint`\n"), "CHG-0001").view;
    expect(noGlobs.autoEligible.terms.find((t) => t.name === "eval coverage for paths")).toMatchObject({ ok: false, detail: "no active eval case for planned paths and no test globs declared in CLAUDE.md" });
    const covered = viewOf(stage4(["src/a.ts"]), "CHG-0001").view;
    expect(covered.autoEligible.terms.find((t) => t.name === "eval coverage for paths")).toMatchObject({ ok: true, detail: "verification includes a test target and test globs (lenient coverage)" });

    const mocked = viewOf(stage4(["src/a.ts"], STANDARD, { "sdlc/changes/CHG-0001/design/notes.md": "# notes\n", "sdlc/changes/CHG-0001/design/dialog.png": "" }), "CHG-0001");
    expect(mocked.files.design.map((d) => d.path)).toEqual(["sdlc/changes/CHG-0001/design/dialog.png", "sdlc/changes/CHG-0001/design/notes.md"]);
    expect(mocked.view.visual.mock?.path).toBe("sdlc/changes/CHG-0001/design/dialog.png");
  });

  it("sessionCeiling: null resolves to no ceiling; unset keeps the default", () => {
    expect(resolveConfig(null).thresholds.sessionCeiling).toBe(4);
    const none = loadRepo(withFiles(baseTree(), { "sdlc/config.yaml": "schema: 1\ndefaultRole: po\nidentities:\n  - { id: po@example.com, roles: [po] }\nthresholds: { sessionCeiling: null }\n" }));
    expect(none.config.thresholds.sessionCeiling).toBeNull();
    expect(none.config.present).toBe(true);
  });
});

describe("AUTO → SUPERVISED override (2.6, P9)", () => {
  const ctx = { now: TS, newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9TX", actor: { id: "eng@example.com" } };

  it("is a ledger event by the engineer, downward only", () => {
    expect(isDowngrade("AUTO", "SUPERVISED")).toBe(true);
    expect(isDowngrade("HEADLESS", "SUPERVISED")).toBe(true);
    expect(isDowngrade("SUPERVISED", "AUTO")).toBe(false);
    expect(isDowngrade("AUTO", "AUTO")).toBe(false);
    const { repo, view } = viewOf(stage4(["src/a.ts"]), "CHG-0001");
    const r = overrideMode(repo, view, { session: "sess-1", from: "AUTO", to: "SUPERVISED", reason: "needs eyes" }, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.plan.files).toEqual([]);
    expect(r.plan.commitMessage).toBe("sdlc(CHG-0001): session sess-1 AUTO → SUPERVISED (needs eyes)");
    expect(r.plan.trailers["SDLC-Actor"]).toBe("human:eng@example.com");
    expect(r.plan.events[0]?.event).toMatchObject({ event: "override.mode", actor: { type: "human", id: "eng@example.com", role: "eng" }, data: { from: "AUTO", to: "SUPERVISED", reason: "needs eyes" } });
    const after = loadRepo(applyWritePlan(repo.tree, r.plan));
    expect(validateTree(after).blocking).toBe(false);
    const line = viewOf(after.tree, "CHG-0001").view.activity.find((a) => a.event === "override.mode");
    expect(line?.text).toBe("mode AUTO → SUPERVISED: needs eyes");

    const up = overrideMode(repo, view, { session: "sess-1", from: "SUPERVISED", to: "AUTO" }, ctx);
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.diagnostics[0]?.rule).toBe("override.upward");
    const po = overrideMode(repo, view, { session: "sess-1", from: "AUTO", to: "SUPERVISED" }, { ...ctx, actor: { id: "po@example.com" } });
    expect(po.ok).toBe(false);
    if (!po.ok) expect(po.diagnostics[0]?.rule).toBe("override.not-engineer");
  });

  it("a ledger carrying an upward override fails validation (blocking)", () => {
    const tree = withFiles(baseTree(), { "CLAUDE.md": CLAUDE(STANDARD) });
    const events = [...acceptedThrough([1, 2, 3]), ev("override.mode", ENG, { from: "SUPERVISED", to: "AUTO", reason: "faster" })];
    const bad = withFiles(tree, changeFiles(tree, { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events }));
    const report = validateTree(loadRepo(bad));
    const d = report.diagnostics.find((x) => x.rule === "override.upward");
    expect(d).toMatchObject({ blocking: true, changeId: "CHG-0001", path: "sdlc/changes/CHG-0001/log.jsonl" });
    expect(d?.message).toBe("eng@example.com recorded mode SUPERVISED → AUTO; autonomy is derived and can only be reduced");
    expect(report.blocking).toBe(true);
    // the same event downward is fine
    const ok = withFiles(tree, changeFiles(tree, { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: [...acceptedThrough([1, 2, 3]), ev("override.mode", PO, { from: "AUTO", to: "SUPERVISED" })] }));
    expect(validateTree(loadRepo(ok)).diagnostics.some((x) => x.rule === "override.upward")).toBe(false);
    void SHA;
  });
});

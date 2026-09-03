import { describe, expect, it } from "vitest";
import { loadRepo } from "../src/repo.js";
import { deriveChange } from "../src/derive.js";
import { budgetStatus, buildEvalRun, configChanges, evalGate, evalSignals, regressions, runForCurrentConfig, suiteStatus, suiteVerdict } from "../src/evals.js";
import { harvestCase, harvestedCase, raiseEvalSignals } from "../src/transitions/evals.js";
import { validateTree } from "../src/validate/index.js";
import { applyWritePlan } from "../src/writeplan.js";
import { newUlid } from "@sdlc/adapter-git";
import { PO, seedTree } from "@sdlc/fixtures";
import { stringifyJson, type EvalRun } from "@sdlc/schemas";
import type { Tree } from "../src/tree.js";

const NOW = "2026-09-04T09:00:00Z";
const ctx = { now: NOW, newId: newUlid, actor: { id: PO, name: "Priya Owens" } };

function withFiles(tree: Tree, files: Record<string, string | null>): Tree {
  const map = new Map(tree.files);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) map.delete(path);
    else map.set(path, { content, sha: `${path.length}`.padStart(40, "0") });
  }
  return { ...tree, files: map };
}

function run(id: string, results: { caseId: string; pass: boolean; output?: string }[], extra: Partial<EvalRun> = {}, configRef?: EvalRun["configRef"]): EvalRun {
  const base = loadRepo(seedTree()).evalRuns[0];
  if (!base) throw new Error("seed run");
  const r = buildEvalRun({ id, trigger: "schedule", configRef: configRef ?? base.configRef, results: results.map((x) => ({ caseId: x.caseId, pass: x.pass, output: x.output ?? (x.pass ? "1 passed" : "1 failed") })), threshold: 0.9, complete: true, cost: 1, startedAt: `2026-09-${String(2 + Number(id.slice(-2))).padStart(2, "0")}T03:00:00Z`, finishedAt: NOW });
  return { ...r, ...extra };
}

function configWith(tree: Tree, patch: string): Tree {
  const cfg = tree.files.get("sdlc/config.yaml")?.content ?? "";
  return withFiles(tree, { "sdlc/config.yaml": `${cfg}${patch}` });
}

describe("suite verdict and run files (2.5)", () => {
  it("pass needs the threshold and a complete run; incomplete is never a pass; an empty active suite passes vacuously", () => {
    expect(suiteVerdict(0.9, 0.9, true)).toBe("pass");
    expect(suiteVerdict(0.89, 0.9, true)).toBe("fail");
    expect(suiteVerdict(1, 0.9, false)).toBe("incomplete");
    const r = run("RUN-0002", [{ caseId: "CASE-0001", pass: true }, { caseId: "CASE-0002", pass: false }]);
    expect(r).toMatchObject({ passRate: 0.5, verdict: "fail", threshold: 0.9 });
    expect(buildEvalRun({ id: "RUN-0009", trigger: "manual", configRef: r.configRef, results: [], threshold: 0.9, complete: true, cost: 0, startedAt: NOW, finishedAt: NOW })).toMatchObject({ passRate: 1, verdict: "pass" });
    expect(buildEvalRun({ id: "RUN-0009", trigger: "manual", configRef: r.configRef, results: [], threshold: 0.9, complete: false, cost: 0, startedAt: NOW, finishedAt: NOW }).verdict).toBe("incomplete");
  });

  it("a run file marked pass below its own threshold blocks validation", () => {
    const tree = seedTree();
    const bad = { ...run("RUN-0002", [{ caseId: "CASE-0001", pass: false }, { caseId: "CASE-0002", pass: true }]), verdict: "pass" as const };
    const report = validateTree(loadRepo(withFiles(tree, { "evals/runs/RUN-0002.json": stringifyJson(bad) })));
    expect(report.diagnostics.find((d) => d.rule === "eval-run.pass-below-threshold")).toMatchObject({ path: "evals/runs/RUN-0002.json", blocking: true });
    expect(validateTree(loadRepo(tree)).diagnostics.some((d) => d.rule === "eval-run.pass-below-threshold")).toBe(false);
  });

  it("regressions carry before/after output verbatim; config changes are named", () => {
    const prev = run("RUN-0001", [{ caseId: "CASE-0001", pass: true, output: "Tests 44 passed (44)" }, { caseId: "CASE-0002", pass: true }]);
    const cur = run("RUN-0002", [{ caseId: "CASE-0001", pass: false, output: "Tests 1 failed | 43 passed\n  ✗ zero-total row missing" }, { caseId: "CASE-0002", pass: true }, { caseId: "CASE-0009", pass: false, output: "boom" }]);
    const r = regressions(prev, cur);
    expect(r.regressed).toEqual([{ caseId: "CASE-0001", before: "Tests 44 passed (44)", after: "Tests 1 failed | 43 passed\n  ✗ zero-total row missing" }]);
    expect(r.newFailures.map((f) => f.caseId)).toEqual(["CASE-0009"]);
    const changed = { ...prev.configRef, claudeMdSha: "f".repeat(40), skills: [{ name: "brand", version: "e".repeat(40) }, { name: "legal", version: "d".repeat(40) }], model: "claude-fable-5-1" };
    expect(configChanges(prev.configRef, changed)).toEqual([`CLAUDE.md ${prev.configRef.claudeMdSha.slice(0, 7)} → fffffff`, `skill brand ${prev.configRef.skills[0]?.version.slice(0, 7)} → eeeeeee`, "skill legal added", "model claude-opus-5 → claude-fable-5-1"]);
    expect(configChanges(null, changed)).toEqual(["first run"]);
    expect(configChanges(changed, changed)).toEqual([]);
  });
});

describe("config-change gate (2.5, acceptance m)", () => {
  it("passes on the latest run under the current config, blocks below threshold with the regressed cases, blocks on incomplete, and is not gated in scheduled mode", () => {
    const tree = seedTree();
    const repo = loadRepo(tree);
    // the seed's RUN-0001 matches the seed's config fingerprint
    expect(runForCurrentConfig(repo)?.id).toBe("RUN-0001");
    expect(evalGate(repo)).toMatchObject({ ok: true, gated: true, run: { id: "RUN-0001" }, regressed: [] });
    // a config change (CLAUDE.md edited) without a run for it
    const edited = withFiles(tree, { "CLAUDE.md": `${tree.files.get("CLAUDE.md")?.content ?? ""}\n- Never guess.\n` });
    const g1 = evalGate(loadRepo(edited));
    expect(g1.ok).toBe(false);
    expect(g1.reason).toContain("no suite run for the current config");
    // a failing run under the new config lists the regression against the last run under the old one
    const fp = loadRepo(edited).fingerprint;
    const failing = run("RUN-0002", [{ caseId: "CASE-0001", pass: false, output: "1 failed: header missing" }, { caseId: "CASE-0002", pass: true }], { trigger: "config-pr" }, { ...fp, model: "unpinned" });
    const g2 = evalGate(loadRepo(withFiles(edited, { "evals/runs/RUN-0002.json": stringifyJson(failing) })));
    expect(g2).toMatchObject({ ok: false, gated: true, run: { id: "RUN-0002" }, baseline: { id: "RUN-0001" }, regressed: [{ caseId: "CASE-0001", before: "1 passed", after: "1 failed: header missing" }] });
    expect(g2.reason).toContain("50% vs threshold 90%");
    // incomplete under the new config never passes, even at 100%
    const stopped = { ...run("RUN-0003", [{ caseId: "CASE-0001", pass: true }], { trigger: "config-pr" }, { ...fp, model: "unpinned" }), verdict: "incomplete" as const };
    const g3 = evalGate(loadRepo(withFiles(edited, { "evals/runs/RUN-0002.json": stringifyJson(failing), "evals/runs/RUN-0003.json": stringifyJson(stopped) })));
    expect(g3.ok).toBe(false);
    expect(g3.reason).toContain("incomplete never counts as pass");
    // scheduled mode: not gated, whatever the runs say
    const scheduled = configWith(withFiles(edited, { "evals/runs/RUN-0002.json": stringifyJson(failing) }).files ? withFiles(edited, { "evals/runs/RUN-0002.json": stringifyJson(failing) }) : edited, "");
    const cfg = (scheduled.files.get("sdlc/config.yaml")?.content ?? "").replace("mode: continuous", "mode: scheduled\n  schedule: \"0 3 * * *\"");
    const g4 = evalGate(loadRepo(withFiles(scheduled, { "sdlc/config.yaml": cfg })));
    expect(g4).toMatchObject({ ok: true, gated: false });
    expect(g4.reason).toContain("not gated");
  });

  it("budget is a rolling 30-day sum of run cost against evals.budget; suite status carries it with the strip", () => {
    const tree = seedTree();
    const repo = loadRepo(tree);
    expect(budgetStatus(repo, NOW)).toEqual({ limit: null, used: 1.42, remaining: null, windowDays: 30, exhausted: false });
    const cfg = (tree.files.get("sdlc/config.yaml")?.content ?? "").replace("threshold: 0.9", "threshold: 0.9\n  budget: 2");
    const limited = loadRepo(withFiles(tree, { "sdlc/config.yaml": cfg }));
    expect(budgetStatus(limited, NOW)).toMatchObject({ limit: 2, used: 1.42, remaining: 0.58, exhausted: false });
    expect(budgetStatus(limited, "2026-11-04T09:00:00Z")).toMatchObject({ used: 0, remaining: 2 });
    const old = withFiles(tree, { "sdlc/config.yaml": cfg, "evals/runs/RUN-0002.json": stringifyJson(run("RUN-0002", [{ caseId: "CASE-0001", pass: true }], { cost: 0.7 })) });
    expect(budgetStatus(loadRepo(old), NOW)).toMatchObject({ used: 2.12, remaining: 0, exhausted: true });
    const status = suiteStatus(repo, NOW);
    expect(status).toMatchObject({ mode: "continuous", threshold: 0.9, active: 2, draft: 1, retired: 0, underSized: true, suiteMinSize: 20, latest: { id: "RUN-0001" }, current: { id: "RUN-0001" }, gate: { ok: true } });
    expect(status.strip).toEqual([{ id: "RUN-0001", verdict: "pass", passRate: 1, trigger: "schedule", startedAt: "2026-09-02T03:00:00Z", model: "claude-opus-5", changes: ["first run"] }]);
  });
});

describe("live-suite signals → triage (2.5)", () => {
  const passing = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`evals/runs/RUN-00${String(i + 2).padStart(2, "0")}.json`, stringifyJson(run(`RUN-00${String(i + 2).padStart(2, "0")}`, [{ caseId: "CASE-0001", pass: true }, { caseId: "CASE-0002", pass: i % 2 === 0 }]))]));

  it("N consecutive passes → retire; M consecutive fails under one config → broken; draft cases, short streaks and config changes never signal", () => {
    const tree = seedTree();
    const cfg = (tree.files.get("sdlc/config.yaml")?.content ?? "").replace("suiteMinSize: 20", "suiteMinSize: 20\n  noDiscriminationRuns: 3\n  brokenCheckRuns: 2");
    const base = withFiles(tree, { "sdlc/config.yaml": cfg });
    // seed RUN-0001 passes both; two more runs: CASE-0001 passes thrice (retire), CASE-0002 alternates (nothing)
    const s1 = evalSignals(loadRepo(withFiles(base, passing(2))));
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ kind: "retire", caseId: "CASE-0001", runs: ["RUN-0001", "RUN-0002", "RUN-0003"], src: "eval-retire:CASE-0001" });
    // one run short of the streak: nothing
    expect(evalSignals(loadRepo(withFiles(base, passing(1))))).toEqual([]);
    // CASE-0002 failing twice under the same config → broken; failing twice across a config change → not
    const fail = (id: string, cfgRef?: EvalRun["configRef"]) => stringifyJson(run(id, [{ caseId: "CASE-0001", pass: false }, { caseId: "CASE-0002", pass: false, output: "boom" }], {}, cfgRef));
    const broken = evalSignals(loadRepo(withFiles(base, { "evals/runs/RUN-0002.json": fail("RUN-0002"), "evals/runs/RUN-0003.json": fail("RUN-0003") })));
    expect(broken.map((s) => [s.kind, s.caseId])).toEqual([["broken", "CASE-0001"], ["broken", "CASE-0002"]]);
    expect(broken[1]?.evidence).toContain("boom");
    const other = { ...loadRepo(base).fingerprint, claudeMdSha: "9".repeat(40) };
    expect(evalSignals(loadRepo(withFiles(base, { "evals/runs/RUN-0002.json": fail("RUN-0002"), "evals/runs/RUN-0003.json": fail("RUN-0003", other) })))).toEqual([]);
    // incomplete runs count for nothing
    const inc = { ...run("RUN-0003", [{ caseId: "CASE-0001", pass: false }, { caseId: "CASE-0002", pass: false }]), verdict: "incomplete" as const };
    expect(evalSignals(loadRepo(withFiles(base, { "evals/runs/RUN-0002.json": fail("RUN-0002"), "evals/runs/RUN-0003.json": stringifyJson(inc) })))).toEqual([]);
  });

  it("raiseEvalSignals writes one triage item per signal (system actor, pre-drafted intent) and never the same streak twice", () => {
    const tree = seedTree();
    const cfg = (tree.files.get("sdlc/config.yaml")?.content ?? "").replace("suiteMinSize: 20", "suiteMinSize: 20\n  noDiscriminationRuns: 3\n  brokenCheckRuns: 2");
    const repo = loadRepo(withFiles(tree, { "sdlc/config.yaml": cfg, ...passing(2) }));
    const r = raiseEvalSignals(repo, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.files.map((f) => f.path)).toEqual(["sdlc/loop/triage/TRI-0044.md"]);
    expect(r.plan.actor).toEqual({ type: "system", id: "sdlc-bot" });
    expect(r.plan.commitMessage).toBe("sdlc(evals): 1 triage item from the suite (retire CASE-0001)");
    const text = r.plan.files[0]?.content ?? "";
    expect(text).toContain("tier: eval-retire");
    expect(text).toContain("src: eval-retire:CASE-0001");
    expect(text).toContain("## Problem");
    expect(text).toContain("retire it or harden its checks");
    const after = loadRepo(applyWritePlan(repo.tree, r.plan));
    expect(after.triage.find((t) => t.data.id === "TRI-0044")?.data).toMatchObject({ tier: "eval-retire", status: "open", title: "CASE-0001 no longer discriminates (100% over 3 runs)" });
    // the streak extends by one run: nothing new
    const extended = loadRepo(withFiles(after.tree, passing(3)));
    const again = raiseEvalSignals(extended, { now: "2026-09-10T09:00:00Z" });
    expect(again.ok).toBe(false);
    // dismissed after the streak began: still not re-raised; dismissed before it began: raised again
    const dismissedText = (after.tree.files.get("sdlc/loop/triage/TRI-0044.md")?.content ?? "").replace("status: open", "status: dismissed\ndismissal:\n  by: po@veri.example\n  reason: keep it\n  at: 2026-09-05T00:00:00Z");
    expect(raiseEvalSignals(loadRepo(withFiles(extended.tree, { "sdlc/loop/triage/TRI-0044.md": dismissedText })), { now: "2026-09-10T09:00:00Z" }).ok).toBe(false);
    const stale = dismissedText.replace(`createdAt: ${NOW}`, "createdAt: 2026-08-01T00:00:00Z");
    expect(raiseEvalSignals(loadRepo(withFiles(extended.tree, { "sdlc/loop/triage/TRI-0044.md": stale })), { now: "2026-09-10T09:00:00Z" }).ok).toBe(true);
  });
});

describe("harvest (2.5, FR-53)", () => {
  it("a merged change becomes a draft case for the platform owner; unmerged and already-harvested changes are refused", () => {
    const repo = loadRepo(seedTree());
    const files = (id: string) => {
      const f = repo.changes.get(id);
      if (!f) throw new Error(id);
      return f;
    };
    // CHG-0012 (Maintain) was harvested by the seed as CASE-0002
    expect(harvestedCase(repo, "CHG-0012")?.id).toBe("CASE-0002");
    expect(deriveChange(repo, files("CHG-0012")).harvested).toEqual({ id: "CASE-0002", status: "active" });
    const dup = harvestCase(repo, deriveChange(repo, files("CHG-0012")), ctx);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.diagnostics[0]?.rule).toBe("harvest.exists");
    const early = harvestCase(repo, deriveChange(repo, files("CHG-0017")), ctx);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.diagnostics[0]?.message).toContain("not merged (stage 5)");
    // a fresh merged change: CHG-0012 without its case
    const without = loadRepo(withFiles(repo.tree, { "evals/cases/CASE-0002.json": null }));
    const view = deriveChange(without, files("CHG-0012"));
    expect(view.harvested).toBeNull();
    const r = harvestCase(without, view, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caseId).toBe("CASE-0004");
    expect(r.plan.files[0]?.path).toBe("evals/cases/CASE-0004.json");
    const written = JSON.parse(r.plan.files[0]?.content ?? "{}") as Record<string, unknown>;
    expect(written).toMatchObject({ id: "CASE-0004", status: "draft", owner: "platform@veri.example", source: { type: "change", ref: "CHG-0012" }, added: NOW, paths: view.planFiles });
    expect(String(written["prompt"])).toContain(view.title);
    expect(String(written["prompt"])).toContain("Behaviour outside this change is unchanged");
    expect((written["checks"] as { name: string; cmd: string }[]).map((c) => c.cmd)).toEqual(["pnpm build", "pnpm test", "pnpm lint"]);
    expect(r.plan.events[0]?.event).toMatchObject({ event: "note", actor: { type: "human", id: PO } });
    expect(r.plan.commitMessage).toBe("sdlc(CHG-0012): harvest CASE-0004 (draft)");
    const after = loadRepo(applyWritePlan(without.tree, r.plan));
    expect(deriveChange(after, after.changes.get("CHG-0012") ?? files("CHG-0012")).harvested).toEqual({ id: "CASE-0004", status: "draft" });
    // draft cases stay out of the active suite
    expect(suiteStatus(after, NOW)).toMatchObject({ active: 1, draft: 2 });
  });
});

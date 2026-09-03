import { describe, expect, it } from "vitest";
import { seedTree } from "@sdlc/fixtures";
import {
  acceptProposal,
  appendClaudeMdLine,
  checkAcceptProposal,
  fileProposal,
  loadRepo,
  normalizeReason,
  pendingRepeatSignals,
  proposalLanded,
  proposalViews,
  raiseEvalSignals,
  reasonKey,
  repeatSignals,
  repoRules,
  skillSignals,
  skillStatus,
  withFiles,
} from "../src/index.js";
import { ENG, PO, SHA, TS, ev, resetSeq } from "./helpers.js";

const NOW = "2026-09-03T12:00:00Z";
const ctx = (actor: { id: string }) => ({ now: NOW, newId: () => `01J8Z6Q7Y2K3M4N5P6Q7RP${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`.slice(0, 26), actor });
const AGENT_A = { type: "agent", id: "claude-code", session: "sess-a" } as const;
const without = (tree: ReturnType<typeof seedTree>, path: string) => ({ ref: tree.ref, files: new Map([...tree.files].filter(([p]) => p !== path)) });
const AGENT_B = { type: "agent", id: "claude-code", session: "sess-b" } as const;

describe("repeat-mistake signal (FR-43)", () => {
  it("normalises reasons and groups them per repository; the seed shows the plan-sync block twice with PRP-0008 answering it", () => {
    expect(normalizeReason("  Commit touches FILES   outside plan.md ")).toBe("commit touches files outside plan.md");
    expect(reasonKey("A b")).toBe(reasonKey(" a   B "));
    const repo = loadRepo(seedTree());
    const signals = repeatSignals(repo);
    expect(signals.map((s) => [s.reason, s.count, s.citations, s.proposal])).toEqual([["commit touches files outside plan.md's file list", 2, ["CHG-0017", "CHG-0018"], { id: "PRP-0008", status: "open" }]]);
    expect(signals[0]?.display).toBe("commit touches files outside plan.md's file list");
    expect(signals[0]?.occurrences.map((o) => [o.changeId, o.via, o.session])).toEqual([["CHG-0017", "plan-sync", "s-0017-build"], ["CHG-0018", "plan-sync", "sess-0018-repro"]]);
    // "test freeze active" was blocked once, by one session: not a repeat
    expect(signals.some((s) => s.reason === "test freeze active")).toBe(false);
    expect(pendingRepeatSignals(repo)).toEqual([]);
    const views = proposalViews(repo);
    expect(views.map((p) => [p.id, p.seen, p.landed])).toEqual([["PRP-0007", 0, false], ["PRP-0008", 2, false]]);
  });

  it("a session hammering the same edit counts once; every send-back counts; a third occurrence counts onto the proposal instead of filing another", () => {
    resetSeq();
    const repo0 = loadRepo(seedTree());
    const files = repo0.changes.get("CHG-0018");
    if (!files) throw new Error("seed");
    const tree = withFiles(seedTree(), {
      "sdlc/changes/CHG-0019/log.jsonl": `${(repo0.changes.get("CHG-0019")?.events ?? []).map((e) => JSON.stringify(e)).join("\n")}\n${[
        ev("hook.blocked", AGENT_A, { hook: "test-freeze", reason: "Test freeze active", path: "test/a.test.ts" }, 1, "2026-09-03T10:00:00Z"),
        ev("hook.blocked", AGENT_A, { hook: "test-freeze", reason: "test freeze active ", path: "test/b.test.ts" }, 1, "2026-09-03T10:00:00Z"),
        ev("gate.sent_back", { ...PO }, { gate: 1, feedback: "Scope too wide" }, 1, "2026-09-03T10:00:00Z"),
        ev("gate.sent_back", { ...PO }, { gate: 1, feedback: "scope too wide" }, 1, "2026-09-03T10:00:00Z"),
        ev("hook.blocked", AGENT_B, { hook: "plan-sync", reason: "commit touches files outside plan.md's file list", path: "src/x.ts" }, 1, "2026-09-03T10:00:00Z"),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    });
    const repo = loadRepo(tree);
    const signals = repeatSignals(repo);
    // one session, same reason twice → one source; the seed's single block on CHG-0018 makes two
    expect(signals.find((s) => s.reason === "test freeze active")?.count).toBe(2);
    expect(signals.find((s) => s.reason === "scope too wide")?.count).toBe(2);
    expect(signals.find((s) => s.reason === "scope too wide")?.occurrences.every((o) => o.session === null && o.via === "gate 1")).toBe(true);
    const planSync = signals.find((s) => s.reason === "commit touches files outside plan.md's file list");
    expect(planSync?.count).toBe(3);
    expect(planSync?.citations).toEqual(["CHG-0017", "CHG-0018", "CHG-0019"]);
    expect(planSync?.proposal).toEqual({ id: "PRP-0008", status: "open" });
    expect(pendingRepeatSignals(repo).map((s) => s.reason).sort()).toEqual(["scope too wide", "test freeze active"]);
    expect(proposalViews(repo).find((p) => p.id === "PRP-0008")?.seen).toBe(3);
    // filing a second proposal for the answered reason is refused; the pending ones file
    const dup = fileProposal(repo, { text: "x", citations: ["CHG-0019"], reason: "Commit touches files outside plan.md's file list", agent: { id: "claude-code", session: "sess-b" } }, ctx(ENG));
    expect(dup.ok).toBe(false);
    expect(dup.ok ? "" : dup.diagnostics[0]?.rule).toBe("proposal.exists");
    const filed = fileProposal(repo, { text: "Never touch a test file while a repro freeze is active; propose the change to the engineer instead.", citations: ["CHG-0019", "CHG-0018"], reason: "Test freeze active", agent: { id: "claude-code", session: "sess-a" } }, ctx(ENG));
    if (!filed.ok) throw new Error(filed.diagnostics.map((d) => d.message).join());
    expect(filed.proposalId).toBe("PRP-0009");
    expect(filed.plan.files[0]?.path).toBe("sdlc/proposals/PRP-0009.yaml");
    expect(filed.plan.files[0]?.content).toContain("reason: test freeze active");
    expect(filed.plan.files[0]?.content).toContain("status: open");
    expect(filed.plan.changeId).toBe("CHG-0019");
    expect(filed.plan.events[0]?.event.actor).toEqual({ type: "agent", id: "claude-code", session: "sess-a" });
    expect(filed.plan.events[0]?.event.event).toBe("note");
    expect(filed.plan.actor).toEqual({ type: "system", id: "sdlc-bot" });
    expect(filed.plan.commitMessage).toBe("sdlc(PRP-0009): propose CLAUDE.md line — Never touch a test file while a repro freeze is active; propose the change to the engineer instead.");
    expect(fileProposal(repo, { text: "two\nlines", citations: [], reason: "scope too wide", agent: { id: "a", session: "s" } }, ctx(ENG)).ok).toBe(false);
    expect(fileProposal(repo, { text: " ", citations: [], reason: "scope too wide", agent: { id: "a", session: "s" } }, ctx(ENG)).ok).toBe(false);
    // once committed, the reason is answered and the count keeps growing on it
    const after = loadRepo(withFiles(tree, { "sdlc/proposals/PRP-0009.yaml": filed.plan.files[0]?.content ?? "" }));
    expect(repeatSignals(after).find((s) => s.reason === "test freeze active")?.proposal).toEqual({ id: "PRP-0009", status: "open" });
    expect(pendingRepeatSignals(after).map((s) => s.reason)).toEqual(["scope too wide"]);
    expect(repoRules(after).some((d) => d.rule === "proposal.reason-duplicate")).toBe(false);
    const twice = loadRepo(withFiles(tree, { "sdlc/proposals/PRP-0009.yaml": filed.plan.files[0]?.content ?? "", "sdlc/proposals/PRP-0010.yaml": (filed.plan.files[0]?.content ?? "").replace("PRP-0009", "PRP-0010") }));
    expect(repoRules(twice).find((d) => d.rule === "proposal.reason-duplicate")?.blocking).toBe(false);
  });
});

describe("accepting a proposal", () => {
  it("appends the line to the working-knowledge list, never elsewhere; idempotent", () => {
    const md = "# Veri\n\nIntro.\n\n- first rule\n- second rule\n\n## Commands\n- Dev: `pnpm dev`\n";
    const out = appendClaudeMdLine(md, "third rule");
    expect(out).toBe("# Veri\n\nIntro.\n\n- first rule\n- second rule\n- third rule\n\n## Commands\n- Dev: `pnpm dev`\n");
    expect(appendClaudeMdLine(out, "third rule")).toBe(out);
    expect(appendClaudeMdLine("# Only a title\n", "a rule")).toBe("# Only a title\n\n- a rule\n");
    expect(appendClaudeMdLine("", "a rule")).toBe("- a rule\n");
  });

  it("eng or platform accepts an open claude-md-line proposal into a branch/PR record; PO, dismissed and landed proposals are refused; the default branch's CLAUDE.md is untouched", () => {
    const repo = loadRepo(seedTree());
    const po = checkAcceptProposal(repo, "PRP-0008", { actor: PO });
    expect(po.ok).toBe(false);
    expect(po.ok ? "" : (po.result.ok ? "" : po.result.diagnostics[0]?.rule)).toBe("proposal.not-owner");
    const platform = checkAcceptProposal(repo, "PRP-0008", { actor: { id: "platform@veri.example" } });
    expect(platform.ok).toBe(true);
    const pre = checkAcceptProposal(repo, "PRP-0008", { actor: { id: "eng@veri.example" } });
    if (!pre.ok) throw new Error("expected ok");
    expect(pre.check.branch).toBe("sdlc/proposals/PRP-0008");
    expect(pre.check.path).toBe("CLAUDE.md");
    expect(pre.check.content).toContain("- Before committing, check every touched path against plan.md");
    expect(pre.check.content.indexOf("- Before committing")).toBeLessThan(pre.check.content.indexOf("## Commands"));
    expect(checkAcceptProposal(repo, "PRP-0042", { actor: { id: "eng@veri.example" } }).ok).toBe(false);

    const accepted = acceptProposal(repo, "PRP-0008", { branch: "sdlc/proposals/PRP-0008", number: 12, url: "https://github.com/acme/widgets/pull/12" }, { ...ctx({ id: "eng@veri.example" }), actor: { id: "eng@veri.example" } });
    if (!accepted.ok) throw new Error(accepted.diagnostics.map((d) => d.message).join());
    expect(accepted.plan.files.map((f) => f.path)).toEqual(["sdlc/proposals/PRP-0008.yaml"]);
    expect(accepted.plan.files[0]?.content).toContain("status: accepted");
    expect(accepted.plan.files[0]?.content).toContain("branch: sdlc/proposals/PRP-0008");
    expect(accepted.plan.files[0]?.content).toContain("number: 12");
    expect(accepted.plan.commitMessage).toBe("sdlc(PRP-0008): accept — CLAUDE.md line in review on PR #12");
    expect(accepted.plan.actor).toEqual({ type: "human", id: "eng@veri.example" });
    const after = loadRepo(withFiles(seedTree(), { "sdlc/proposals/PRP-0008.yaml": accepted.plan.files[0]?.content ?? "" }));
    expect(after.proposals.find((p) => p.id === "PRP-0008")?.pr).toEqual({ branch: "sdlc/proposals/PRP-0008", number: 12, url: "https://github.com/acme/widgets/pull/12" });
    expect(proposalLanded(after, after.proposals.find((p) => p.id === "PRP-0008") ?? { text: "", type: "claude-md-line" })).toBe(false);
    expect(acceptProposal(after, "PRP-0008", { branch: "x" }, { ...ctx({ id: "eng@veri.example" }), actor: { id: "eng@veri.example" } }).ok).toBe(false);
    // the PR merged (the default branch carries the line): landed, and a fresh accept is refused as already there
    const merged = loadRepo(withFiles(seedTree(), { "CLAUDE.md": pre.check.content }));
    expect(proposalViews(merged).find((p) => p.id === "PRP-0008")?.landed).toBe(true);
    const again = checkAcceptProposal(merged, "PRP-0008", { actor: { id: "eng@veri.example" } });
    expect(again.ok ? "" : (again.result.ok ? "" : again.result.diagnostics[0]?.rule)).toBe("proposal.landed");
    const noClaude = loadRepo(without(seedTree(), "CLAUDE.md"));
    const missing = checkAcceptProposal(noClaude, "PRP-0008", { actor: { id: "eng@veri.example" } });
    expect(missing.ok ? "" : (missing.result.ok ? "" : missing.result.diagnostics[0]?.rule)).toBe("claude-md.missing");
  });
});

describe("skills: backed-by, pass % from trigger tests, findings citing (spec 5A.3)", () => {
  it("the seed's brand skill is backed by plan-sync (team scope), 100% on its one trigger test in RUN-0001, and findings citing it are counted", () => {
    const repo = loadRepo(seedTree());
    const [brand] = skillStatus(repo);
    expect(brand).toMatchObject({ name: "brand", backedBy: "plan-sync", backing: "hook", backingScope: "team", mustHold: true, mustHoldWithoutHook: false, triggerTests: { total: 1, active: 1 }, run: "RUN-0001", passed: 1, passPct: 100, belowThreshold: false });
    expect(brand?.version).toBe(repo.fingerprint.skills[0]?.version.slice(0, 7));
    expect(brand?.passNote).toBe("1 of 1 trigger prompts loaded it (RUN-0001)");
    expect(typeof brand?.findingsCiting).toBe("number");
    expect(skillSignals(repo)).toEqual([]);
    expect(repoRules(repo).some((d) => d.rule === "skill.backed-by.unknown")).toBe(false);
  });

  it("no trigger tests → n/a; a named hook that is not installed → unknown-hook + warning; below the threshold → amber and a skill-trigger triage item once per run", () => {
    const base = seedTree();
    const none = loadRepo(without(base, "evals/cases/CASE-0004.json"));
    expect(skillStatus(none)[0]).toMatchObject({ passPct: null, passNote: "n/a · needs trigger tests", triggerTests: { total: 0, active: 0 } });
    const unknown = loadRepo(withFiles(base, { ".claude/skills/brand/SKILL.md": "---\nname: brand\ndescription: Use when writing copy.\nowner: marketing@veri.example\nbacked_by: brand-guard\nmust_hold: true\n---\n# Brand\n" }));
    expect(skillStatus(unknown)[0]).toMatchObject({ backing: "unknown-hook", backedBy: "brand-guard", mustHoldWithoutHook: true });
    expect(repoRules(unknown).find((d) => d.rule === "skill.backed-by.unknown")?.message).toContain("brand-guard");
    const run = JSON.parse(seedTree().files.get("evals/runs/RUN-0001.json")?.content ?? "{}") as { results: { caseId: string; pass: boolean; output: string }[] };
    const failed = { ...run, results: run.results.map((r) => (r.caseId === "CASE-0004" ? { ...r, pass: false, output: "not loaded: skill brand" } : r)), passRate: 0.667, verdict: "fail" };
    const below = loadRepo(withFiles(base, { "evals/runs/RUN-0001.json": `${JSON.stringify(failed, null, 2)}\n` }));
    expect(skillStatus(below)[0]).toMatchObject({ passPct: 0, belowThreshold: true, passed: 0 });
    const signals = skillSignals(below);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "skill", skill: "brand", caseId: "CASE-0004", src: "skill-trigger:brand", runs: ["RUN-0001"] });
    expect(signals[0]?.evidence).toContain("not loaded: skill brand");
    const raised = raiseEvalSignals(below, { now: NOW });
    if (!raised.ok) throw new Error("expected a triage item");
    expect(raised.signals?.map((s) => s.kind)).toEqual(["skill"]);
    const item = raised.plan.files[0];
    expect(item?.path).toBe("sdlc/loop/triage/TRI-0044.md");
    expect(item?.content).toContain("tier: skill-trigger");
    expect(item?.content).toContain("src: skill-trigger:brand");
    expect(item?.content).toContain(".claude/skills/brand/SKILL.md");
    expect(raised.plan.commitMessage).toBe("sdlc(evals): 1 triage item from the suite (skill brand)");
    const withItem = loadRepo(withFiles(below.tree, { [item?.path ?? "x"]: item?.content ?? "" }));
    expect(raiseEvalSignals(withItem, { now: NOW }).ok).toBe(false);
  });
});

void SHA;
void TS;

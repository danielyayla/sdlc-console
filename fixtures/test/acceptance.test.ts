import { describe, expect, it } from "vitest";
import {
  accept,
  acceptTriage,
  applyWritePlan,
  badges,
  check,
  deriveAll,
  deriveChange,
  escalateFinding,
  gateQueues,
  loadRepo,
  pipeline,
  sendBack,
  validateTree,
  type ChangeView,
  type Repo,
  type TransitionContext,
  type Tree,
} from "@sdlc/core";
import { blobSha } from "@sdlc/adapter-git";
import { ENG, PO, SEED_CHANGE_IDS, seedTree } from "../src/index.js";

let n = 0;
const ctx = (id: string, extra: Partial<TransitionContext> = {}): TransitionContext => ({
  now: "2026-09-03T12:00:00Z",
  newId: () => `01J8Z6Q7Y2K3M4N5P6Q7R8T${(++n).toString(36).toUpperCase().padStart(3, "0")}`.replace(/[ILOU]/g, "X"),
  actor: { id },
  blobSha,
  ...extra,
});

function view(repo: Repo, id: string): ChangeView {
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return deriveChange(repo, files);
}
function plan<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }>["plan" & keyof Extract<T, { ok: true }>] {
  if (!r.ok) throw new Error(JSON.stringify((r as unknown as { diagnostics: unknown }).diagnostics));
  return (r as unknown as { plan: never }).plan;
}

describe("the seed reproduces the spec (design-spec §2)", () => {
  const tree: Tree = seedTree();
  const repo = loadRepo(tree);
  const snap = deriveAll(repo);

  it("has 8 valid changes in the seed's stage distribution, 2 triage, 3 findings", () => {
    expect(snap.changes.map((c) => c.id).sort()).toEqual([...SEED_CHANGE_IDS]);
    expect(snap.changes.every((c) => c.valid)).toBe(true);
    expect(pipeline(snap.changes).map((col) => [col.stage, col.changes.map((c) => c.id)])).toEqual([
      [1, ["CHG-0023", "CHG-0022"]],
      [2, ["CHG-0021"]],
      [3, ["CHG-0020", "CHG-0019"]],
      [4, ["CHG-0018"]],
      [5, ["CHG-0017"]],
      [6, ["CHG-0012"]],
    ]);
    expect(repo.triage.map((t) => t.data.id)).toEqual(["TRI-0042", "TRI-0043"]);
    expect(repo.findings.map((f) => [f.id, f.status])).toEqual([["SEC-0118", "new"], ["SEC-0119", "new"], ["SEC-0120", "patch_pr"]]);
  });

  it("validates with nothing blocking (suite size is the only advisory)", () => {
    const r = validateTree(repo);
    expect(r.diagnostics.filter((d) => d.blocking)).toEqual([]);
    expect(r.diagnostics.map((d) => d.rule)).toEqual(["eval-suite.under-sized"]);
  });

  it("parses the config the console reads", () => {
    expect(repo.verification?.commands.map((c) => c.name)).toEqual(["build", "test", "lint"]);
    expect(repo.settings?.hooks.filter((h) => h.source === "hooks").map((h) => [h.name, h.phase])).toEqual([["test-freeze", "edit"], ["plan-sync", "commit"], ["verify-before-done", "stop"]]);
    expect(repo.skills.map((s) => [s.name, s.backedBy, s.mustHold])).toEqual([["brand", "plan-sync", true]]);
    expect(repo.agents.map((a) => a.name)).toEqual(["reviewer"]);
    expect(repo.bands?.metrics.map((m) => m.metric)).toEqual(["p95_latency_ms", "error_rate_pct"]);
    expect(repo.claudeMd?.workingRule).toContain("twice");
  });

  it("(a) accepting gate 1 on CHG-0022 moves it to Design with intent.md committed", () => {
    const v = view(repo, "CHG-0022");
    expect(v.gate).toMatchObject({ s: 1, ownerRole: "po" });
    const p = plan(accept(repo, v, 1, ctx(PO)));
    const after = loadRepo(applyWritePlan(tree, p));
    const next = view(after, "CHG-0022");
    expect(next.stage).toBe(2);
    expect(next.stageName).toBe("Design");
    expect(next.docs[0].state).toBe("committed");
    expect(next.gate).toBeNull();
    expect(next.agent).toBe(true);
    expect(validateTree(after).blocking).toBe(false);
  });

  it("(b) accepting the incident gate on CHG-0012 loops it to Plan with 'loop closed'", () => {
    const v = view(repo, "CHG-0012");
    expect(v.gate).toMatchObject({ s: 6, ownerRole: "po" });
    const p = plan(accept(repo, v, 6, ctx(PO)));
    const after = loadRepo(applyWritePlan(tree, p));
    const next = view(after, "CHG-0012");
    expect(next.cycle).toBe(2);
    expect(next.stage).toBe(1);
    expect(next.status).toBe("Loop closed — re-entered Plan from incident");
    expect(next.kind).toBe("fix");
    expect(after.evalCases.some((c) => c.id === "INC-CHG-0012-1" && c.status === "draft")).toBe(true);
    expect(after.changes.get("CHG-0012")?.archivedCycles).toEqual([1]);
    expect(validateTree(after).blocking).toBe(false);
  });

  it("(c) accepting TRI-0042 creates a change in Plan and the Loop badge decrements", () => {
    expect(badges(snap.changes, repo, "po").loop).toBe(2);
    const p = plan(acceptTriage(repo, "TRI-0042", ctx(PO)));
    const after = loadRepo(applyWritePlan(tree, p));
    const all = deriveAll(after);
    const created = all.changes.find((c) => c.id === "CHG-0024");
    expect(created).toBeDefined();
    expect(created?.stage).toBe(1);
    expect(created?.origin).toEqual({ type: "triage", ref: "TRI-0042" });
    expect(created?.gate?.s).toBe(1);
    expect(created?.status).toBe("Intent drafted via TRI-0042");
    expect(after.triage.map((t) => t.data.id)).toEqual(["TRI-0043"]);
    expect(badges(all.changes, after, "po").loop).toBe(1);
    expect(validateTree(after).blocking).toBe(false);
  });

  it("(d) escalating SEC-0118 creates a change and marks the finding escalated; Security badge decrements", () => {
    expect(badges(snap.changes, repo, "eng").security).toBe(2);
    expect(escalateFinding(repo, "SEC-0118", ctx(PO)).ok).toBe(false);
    const p = plan(escalateFinding(repo, "SEC-0118", ctx(ENG)));
    const after = loadRepo(applyWritePlan(tree, p));
    const all = deriveAll(after);
    const created = all.changes.find((c) => c.origin.ref === "SEC-0118");
    expect(created).toMatchObject({ id: "CHG-0024", stage: 1, kind: "fix", risk: "high" });
    expect(created?.gate?.s).toBe(1);
    expect(after.findings.find((f) => f.id === "SEC-0118")).toMatchObject({ status: "escalated", escalatedTo: "CHG-0024" });
    expect(after.evalCases.some((c) => c.id === "CASE-SEC-0118" && c.status === "draft")).toBe(true);
    expect(badges(all.changes, after, "eng").security).toBe(1);
    expect(validateTree(after).blocking).toBe(false);
  });

  it("(e) switching role swaps the Gates lists", () => {
    const po = gateQueues(snap.changes, "po");
    const eng = gateQueues(snap.changes, "eng");
    // newest `since` first: CHG-0022's intent (09-02 09:12) is newer than CHG-0012's incident (09-02 07:30)
    expect(po.yours.map((c) => [c.id, c.gate?.s])).toEqual([["CHG-0022", 1], ["CHG-0012", 6], ["CHG-0021", 2]]);
    expect(po.other.map((c) => [c.id, c.gate?.s])).toEqual([["CHG-0020", 3], ["CHG-0019", 3], ["CHG-0017", 5]]);
    expect(eng.yours.map((c) => c.id)).toEqual(["CHG-0020", "CHG-0017"]);
    expect(eng.other.map((c) => c.id)).toEqual(["CHG-0022", "CHG-0012", "CHG-0019", "CHG-0021"]);
    expect(badges(snap.changes, repo, "po").gates).toBe(3);
    expect(badges(snap.changes, repo, "eng").gates).toBe(2);
  });

  it("(f) sending spec.md back on CHG-0021 keeps the stage and re-enters agent revision", () => {
    const v = view(repo, "CHG-0021");
    expect(v.gate?.s).toBe(2);
    const p = plan(sendBack(repo, v, 2, "resolve the brand concern before approval", ctx(PO)));
    const next = view(loadRepo(applyWritePlan(tree, p)), "CHG-0021");
    expect(next.stage).toBe(2);
    expect(next.gate).toBeNull();
    expect(next.agent).toBe(true);
    expect(next.status).toBe("Agent revising spec.md per feedback");
    expect(next.activity[0]?.text).toContain("resolve the brand concern");
  });

  it("(g) high-risk CHG-0019 waits on the tech lead via PR, no in-console Accept", () => {
    const v = view(repo, "CHG-0019");
    expect(v.gate).toMatchObject({ s: 3, ownerRole: "tech_lead", mode: "via_pr" });
    expect(v.planRev).toBe(3);
    expect(v.autoEligible.value).toBe(false);
  });

  it("(h) routine CHG-0020 is AUTO eligible with the rationale terms", () => {
    const v = view(repo, "CHG-0020");
    expect(v.gate).toMatchObject({ s: 3, ownerRole: "eng", mode: "console" });
    expect(v.autoEligible.value).toBe(true);
    expect(v.autoEligible.terms.every((t) => t.ok)).toBe(true);
  });

  it("(k) fix change CHG-0018 has a committed repro; test edits are blocked and counted", () => {
    const v = view(repo, "CHG-0018");
    expect(v.repro?.state).toBe("committed");
    const files = repo.changes.get("CHG-0018");
    expect(check.testFreeze("test/export/csv.test.ts", v, files ?? null, repo.verification?.testGlobs ?? []).allowed).toBe(false);
    expect(check.testFreeze("src/export/csv.ts", v, files ?? null, repo.verification?.testGlobs ?? []).allowed).toBe(true);
    // one test-freeze block (counted as a test-edit attempt) and one plan-sync block (half of the seed's repeat signal, 2.8)
    expect(v.activity.filter((a) => a.event === "hook.blocked")).toHaveLength(2);
    expect(v.activity.filter((a) => a.text.includes("test-freeze"))).toHaveLength(1);
  });

  it("(l) green run moved CHG-0017 to Deploy with no click; red keeps CHG-0018 in Test", () => {
    expect(view(repo, "CHG-0017")).toMatchObject({ stage: 5, evalsState: "green" });
    expect(view(repo, "CHG-0017").gate).toMatchObject({ s: 5, acceptLabel: "Merge" });
    expect(view(repo, "CHG-0018")).toMatchObject({ stage: 4, evalsState: "red", status: "Evals red — agent fixing" });
  });
});

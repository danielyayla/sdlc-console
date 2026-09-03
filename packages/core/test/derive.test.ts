import { beforeEach, describe, expect, it } from "vitest";
import { deriveAll, deriveChange, deriveStage, loadRepo } from "../src/index.js";
import { AGENT, PO, SHA, SYSTEM, acceptedThrough, baseTree, changeFiles, ev, resetSeq, withChange } from "./helpers.js";
import { withFiles } from "../src/index.js";

function view(tree: ReturnType<typeof baseTree>, id: string) {
  const repo = loadRepo(tree);
  const files = repo.changes.get(id);
  if (!files) throw new Error(`no ${id}`);
  return deriveChange(repo, files);
}

beforeEach(resetSeq);

describe("deriveStage", () => {
  it("is a pure function of accepted gates, eval verdict and merge", () => {
    const s = (gates: number[], green = false, merged = false) =>
      deriveStage({ acceptedGates: new Set(gates), greenRunMatchesConfig: green, prMerged: merged });
    expect(s([])).toBe(1);
    expect(s([1])).toBe(2);
    expect(s([1, 2])).toBe(3);
    expect(s([1, 2, 3])).toBe(4);
    expect(s([1, 2, 3], true)).toBe(5);
    expect(s([1, 2, 3], true, true)).toBe(6);
    expect(s([1, 2, 3, 5], true, false)).toBe(5);
  });
});

describe("deriveChange at every stage", () => {
  it("stage 1: intent committed opens gate 1 for the PO", () => {
    const tree = withChange(baseTree(), {
      id: "CHG-0001",
      intent: true,
      events: [ev("artifact.committed", AGENT, { artifact: 0, path: "intent.md", sha: SHA })],
    });
    const v = view(tree, "CHG-0001");
    expect(v.valid).toBe(true);
    expect(v.stage).toBe(1);
    expect(v.gate).toMatchObject({ s: 1, ownerRole: "po", label: "Accept intent.md", acceptLabel: "Accept", mode: "console" });
    expect(v.gate?.since).toBe("2026-09-03T10:01:00Z");
    expect(v.agent).toBe(false);
    expect(v.status).toBe("intent.md committed — waiting on the product owner");
    expect(v.docs[0].state).toBe("pending-review");
    expect(v.docs[1].state).toBe("absent");
  });

  it("stage 1 with no intent yet: agent producing, no gate", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0002" }), "CHG-0002");
    expect(v.stage).toBe(1);
    expect(v.gate).toBeNull();
    expect(v.agent).toBe(true);
    expect(v.status).toBe("Agent producing intent.md");
  });

  it("stage 1 from triage shows the origin in the status", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0003", intent: true, origin: { type: "triage", ref: "TRI-0042" } }), "CHG-0003");
    expect(v.gate?.s).toBe(1);
    expect(v.status).toBe("Intent drafted via TRI-0042");
  });

  it("stage 2 after gate 1: agent producing spec; intent committed", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0004", intent: true, events: acceptedThrough([1]) }), "CHG-0004");
    expect(v.stage).toBe(2);
    expect(v.gate).toBeNull();
    expect(v.agent).toBe(true);
    expect(v.docs[0].state).toBe("committed");
    expect(v.acceptedGates).toEqual([1]);
  });

  it("send-back keeps the stage and re-enters agent revision (acceptance f)", () => {
    const events = [
      ...acceptedThrough([1]),
      ev("artifact.committed", AGENT, { artifact: 1, path: "spec.md", sha: SHA }),
      ev("gate.sent_back", PO, { gate: 2, feedback: "missing the export format" }),
    ];
    const v = view(withChange(baseTree(), { id: "CHG-0005", intent: true, spec: true, events }), "CHG-0005");
    expect(v.stage).toBe(2);
    expect(v.gate).toBeNull();
    expect(v.agent).toBe(true);
    expect(v.status).toBe("Agent revising spec.md per feedback");
    expect(v.docs[1].state).toBe("draft");
    expect(v.activity[0]?.text).toContain("sent spec.md back with feedback: missing the export format");
  });

  it("stage 3: plan draft not final → no gate; final → gate 3 for the engineer", () => {
    const drafting = [
      ...acceptedThrough([1, 2]),
      ev("artifact.committed", AGENT, { artifact: 2, path: "plan.md", sha: SHA }),
      ev("plan.drafted", AGENT, { rev: 2 }),
    ];
    const d = view(withChange(baseTree(), { id: "CHG-0006", intent: true, spec: true, plan: { files: ["src/a.ts"], rev: 2 }, events: drafting }), "CHG-0006");
    expect(d.stage).toBe(3);
    expect(d.gate).toBeNull();
    expect(d.planState).toBe("draft");
    expect(d.planRev).toBe(2);
    expect(d.status).toBe("Agent drafting plan.md · rev 2");

    const final = [...drafting, ev("plan.final", AGENT, { rev: 2 })];
    const f = view(withChange(baseTree(), { id: "CHG-0006", intent: true, spec: true, plan: { files: ["src/a.ts"], rev: 2 }, events: final }), "CHG-0006");
    expect(f.gate).toMatchObject({ s: 3, ownerRole: "eng", label: "Accept plan.md" });
    expect(f.docs[2].state).toBe("pending-review");
  });

  it("high-risk gate 3 is owned by the tech lead via PR (acceptance g)", () => {
    const events = [...acceptedThrough([1, 2]), ev("artifact.committed", AGENT, { artifact: 2, path: "plan.md", sha: SHA }), ev("plan.final", AGENT, { rev: 1 })];
    const v = view(withChange(baseTree(), { id: "CHG-0007", risk: "high", intent: true, spec: true, plan: true, events }), "CHG-0007");
    expect(v.gate).toMatchObject({ s: 3, ownerRole: "tech_lead", mode: "via_pr", label: "Accept plan.md · tech lead" });
    expect(v.status).toContain("tech lead");
    expect(v.autoEligible.value).toBe(false);
    expect(v.autoEligible.terms.find((t) => t.name === "risk routine")?.ok).toBe(false);
  });

  it("high-risk plan accepted outside a PR merge is a validation error", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0008", risk: "high", intent: true, spec: true, plan: true, events: acceptedThrough([1, 2, 3]) }), "CHG-0008");
    expect(v.valid).toBe(false);
    expect(v.validationErrors.map((d) => d.rule)).toContain("gate3.high-risk.source");
    expect(v.gate).toBeNull();
  });

  it("stage 4: no runs → running; one red → agent fixing; two reds → waiting on you (acceptance l)", () => {
    const base = { id: "CHG-0009", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: acceptedThrough([1, 2, 3]) };
    const t = baseTree();
    const running = view(withChange(t, base), "CHG-0009");
    expect(running.stage).toBe(4);
    expect(running.evalsState).toBe("running");
    expect(running.agent).toBe(true);
    expect(running.planState).toBe("committed");
    expect(running.docs[2].state).toBe("committed");

    const red = view(withChange(t, { ...base, runs: ["red"] }), "CHG-0009");
    expect(red.stage).toBe(4);
    expect(red.evalsState).toBe("red");
    expect(red.status).toBe("Evals red — agent fixing");

    const waiting = view(withChange(t, { ...base, runs: ["red", "red"] }), "CHG-0009");
    expect(waiting.evalsState).toBe("waiting");
    expect(waiting.agent).toBe(false);
    expect(waiting.waitingOnYou).toBe("evals red twice");
    expect(waiting.status).toBe("waiting on you: evals red twice");
  });

  it("a green run only counts when its config fingerprint matches the current tree", () => {
    const base = { id: "CHG-0010", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: acceptedThrough([1, 2, 3]) };
    const stale = view(withChange(baseTree(), { ...base, runs: ["green-stale"] }), "CHG-0010");
    expect(stale.stage).toBe(4);
    expect(stale.evalsState).toBe("stale");
    const green = view(withChange(baseTree(), { ...base, runs: ["red", "green"], pr: {} }), "CHG-0010");
    expect(green.stage).toBe(5);
  });

  it("stage 5: PR open → Merge gate for the engineer with since = PR opened time", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0011", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], pr: { openedAt: "2026-09-03T12:34:00Z" }, events: acceptedThrough([1, 2, 3]) }), "CHG-0011");
    expect(v.stage).toBe(5);
    expect(v.gate).toMatchObject({ s: 5, ownerRole: "eng", acceptLabel: "Merge", label: "Merge PR", since: "2026-09-03T12:34:00Z" });
    expect(v.docs[3].state).toBe("committed");
    expect(v.docs[4].state).toBe("pending-review");
    expect(v.planMatches).toBe(true);
  });

  it("green evals without pr.yaml is inconsistent", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0012", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], events: acceptedThrough([1, 2, 3]) }), "CHG-0012");
    expect(v.valid).toBe(false);
    expect(v.validationErrors.map((d) => d.rule)).toContain("pr.missing");
  });

  it("stage 6: merged → monitoring; incident committed opens gate 6 for the PO", () => {
    const base = { id: "CHG-0013", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"] as ["green"], pr: { merged: true } };
    const monitoring = view(withChange(baseTree(), { ...base, events: [...acceptedThrough([1, 2, 3]), ev("pr.merged", SYSTEM, { mergeSha: SHA })] }), "CHG-0013");
    expect(monitoring.stage).toBe(6);
    expect(monitoring.gate).toBeNull();
    expect(monitoring.agent).toBe(false);
    expect(monitoring.status).toBe("Deployed · monitoring");
    expect(monitoring.docs[4].state).toBe("committed");

    const events = [...acceptedThrough([1, 2, 3]), ev("pr.merged", SYSTEM, { mergeSha: SHA }), ev("artifact.committed", AGENT, { artifact: 5, path: "incident.md", sha: SHA })];
    const incident = view(withChange(baseTree(), { ...base, incident: true, events }), "CHG-0013");
    expect(incident.gate).toMatchObject({ s: 6, ownerRole: "po", label: "Accept incident intent" });
    expect(incident.docs[5].state).toBe("pending-review");
  });

  it("gate 6 accepted without the cycle advancing is a validation error; a looped change is back at stage 1 (acceptance b)", () => {
    const stuck = view(withChange(baseTree(), { id: "CHG-0014", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], pr: { merged: true }, incident: true, events: acceptedThrough([1, 2, 3, 6]) }), "CHG-0014");
    expect(stuck.valid).toBe(false);
    expect(stuck.validationErrors.map((d) => d.rule)).toContain("loop.not-applied");

    const looped = withChange(baseTree(), { id: "CHG-0015", cycle: 2, events: [...acceptedThrough([1, 2, 3, 6], 1), ev("cycle.archived", SYSTEM, { cycle: 1, into: "cycles/1" }, 2)] });
    const v = view(looped, "CHG-0015");
    expect(v.valid).toBe(true);
    expect(v.stage).toBe(1);
    expect(v.cycle).toBe(2);
    expect(v.status).toBe("Loop closed — re-entered Plan from incident");
    expect(v.agent).toBe(true);
  });

  it("marks an accepted artifact stale when re-committed after acceptance", () => {
    const events = [...acceptedThrough([1]), ev("artifact.committed", AGENT, { artifact: 0, path: "intent.md", sha: SHA })];
    const v = view(withChange(baseTree(), { id: "CHG-0016", intent: true, events }), "CHG-0016");
    expect(v.docs[0].state).toBe("stale");
  });

  it("planMatches follows the last plan-sync hook decision (acceptance i)", () => {
    const events = [...acceptedThrough([1, 2, 3]), ev("hook.blocked", AGENT, { hook: "plan-sync", reason: "src/c.ts not in plan", path: "src/c.ts" })];
    const v = view(withChange(baseTree(), { id: "CHG-0017", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events }), "CHG-0017");
    expect(v.planMatches).toBe(false);
    const allowed = view(withChange(baseTree(), { id: "CHG-0017", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: [...events, ev("hook.allowed", AGENT, { hook: "plan-sync" })] }), "CHG-0017");
    expect(allowed.planMatches).toBe(true);
  });

  it("gates accepted out of order are a validation error", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0018", intent: true, spec: true, events: acceptedThrough([2]) }), "CHG-0018");
    expect(v.valid).toBe(false);
    expect(v.validationErrors.map((d) => d.rule)).toContain("gate.out-of-order");
  });

  it("a closed change has no gate and is not agent work", () => {
    const base = baseTree();
    const files = changeFiles(base, { id: "CHG-0019", intent: true });
    const yamlPath = "sdlc/changes/CHG-0019/change.yaml";
    files[yamlPath] = (files[yamlPath] ?? "").replace("closed: null", 'closed: { at: "2026-09-03T11:00:00Z", reason: rejected }');
    const v = view(withFiles(base, files), "CHG-0019");
    expect(v.gate).toBeNull();
    expect(v.agent).toBe(false);
    expect(v.status).toBe("Closed — rejected");
  });
});

describe("auto eligibility (acceptance h)", () => {
  const plan = (files: string[]) => ({ files, accepted: true });
  it("holds for a routine change with a small plan, a test target and a verification block", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0020", intent: true, spec: true, plan: plan(["src/a.ts"]), events: acceptedThrough([1, 2, 3]) }), "CHG-0020");
    expect(v.autoEligible.value).toBe(true);
    expect(v.autoEligible.terms.map((t) => [t.name, t.ok])).toEqual([
      ["spec committed", true],
      ["risk routine", true],
      ["files in plan ≤ 3", true],
      ["eval coverage for paths", true],
      ["verification block present", true],
    ]);
  });
  it("fails when the plan exceeds the file threshold", () => {
    const v = view(withChange(baseTree(), { id: "CHG-0021", intent: true, spec: true, plan: plan(["a", "b", "c", "d"]), events: acceptedThrough([1, 2, 3]) }), "CHG-0021");
    expect(v.autoEligible.value).toBe(false);
    expect(v.autoEligible.terms[2]).toMatchObject({ ok: false, detail: "4 files in plan" });
  });
  it("fails without a verification block", () => {
    const t = withChange(baseTree(), { id: "CHG-0022", intent: true, spec: true, plan: plan(["a"]), events: acceptedThrough([1, 2, 3]) });
    const noClaude = { ...t, files: new Map([...t.files].filter(([p]) => p !== "CLAUDE.md")) };
    const v = view(noClaude, "CHG-0022");
    expect(v.autoEligible.value).toBe(false);
    expect(v.autoEligible.terms[4]?.ok).toBe(false);
    expect(v.autoEligible.terms[3]?.ok).toBe(false);
  });
});

describe("deriveAll", () => {
  it("sorts newest id first and carries repo diagnostics", () => {
    const tree = withChange(withChange(baseTree(), { id: "CHG-0001", intent: true }), { id: "CHG-0002" });
    const snap = deriveAll(loadRepo(tree));
    expect(snap.changes.map((c) => c.id)).toEqual(["CHG-0002", "CHG-0001"]);
    expect(snap.diagnostics).toEqual([]);
  });
});

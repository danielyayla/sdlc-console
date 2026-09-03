import { beforeEach, describe, expect, it } from "vitest";
import { validate } from "@sdlc/schemas";
import {
  accept,
  acceptTriage,
  applyWritePlan,
  confirmRepro,
  confirmTasks,
  createChange,
  dismissFinding,
  dismissProposal,
  dismissTriage,
  escalateFinding,
  importFindings,
  intentFromIncident,
  loadRepo,
  mergeOverlaps,
  nextChangeId,
  patchFinding,
  proposeTasks,
  sendBack,
  withFiles as withFilesT,
  type TransitionContext,
  type WritePlan,
} from "../src/index.js";
import { AGENT, SHA, SYSTEM, acceptedThrough, baseTree, ev, resetSeq, viewOf, withChange } from "./helpers.js";

let n = 0;
const ctxFor = (actorId: string, extra: Partial<TransitionContext> = {}): TransitionContext => ({
  now: "2026-09-04T09:00:00Z",
  newId: () => `01J8Z6Q7Y2K3M4N5P6Q7R8S${(++n).toString(36).toUpperCase().padStart(3, "0")}`.replace(/[ILOU]/g, "X"),
  actor: { id: actorId },
  ...extra,
});
const PO_CTX = () => ctxFor("po@example.com");
const ENG_CTX = () => ctxFor("eng@example.com");

function expectOk(r: ReturnType<typeof accept>): WritePlan {
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
}

beforeEach(() => {
  resetSeq();
  n = 0;
});

describe("createChange", () => {
  it("allocates the next id, writes change.yaml + intent.md from the template and logs two events", () => {
    const tree = withChange(withChange(baseTree(), { id: "CHG-0001" }), { id: "CHG-0007" });
    const repo = loadRepo(tree);
    const plan = expectOk(createChange(repo, { title: "Invoice CSV export", kind: "feature", risk: "routine", origin: { type: "idea" } }, PO_CTX()));
    expect(plan.changeId).toBe("CHG-0008");
    expect(plan.files.map((f) => f.path)).toEqual(["sdlc/changes/CHG-0008/change.yaml", "sdlc/changes/CHG-0008/intent.md"]);
    expect(plan.commitMessage).toBe("sdlc(CHG-0008): create change · intent.md");
    expect(plan.trailers["SDLC-Actor"]).toBe("human:po@example.com");
    expect(plan.events.map((e) => e.event.event)).toEqual(["change.created", "artifact.committed"]);

    const after = applyWritePlan(tree, plan);
    const { view } = viewOf(after, "CHG-0008");
    expect(view.valid).toBe(true);
    expect(view.stage).toBe(1);
    // the template intent still has placeholders, so gate 1 stays closed until it is completed
    expect(view.gate).toBeNull();
    expect(view.status).toMatch(/^Agent producing intent.md · draft incomplete/);
    expect(view.title).toBe("Invoice CSV export");
    expect(view.docs[0].state).toBe("draft");
    expect(after.files.get("sdlc/changes/CHG-0008/intent.md")?.content).toContain("# Intent: Invoice CSV export");
    for (const e of plan.events) expect(validate("event", e.event).ok).toBe(true);
  });

  it("uses knownIds from other branches and a provided intent body", () => {
    const repo = loadRepo(baseTree());
    const plan = expectOk(createChange(repo, { title: "T", kind: "fix", risk: "high", origin: { type: "triage", ref: "TRI-0042" }, intentBody: "# Intent: T\n\n## Problem\nx\n" }, ctxFor("po@example.com", { knownIds: ["CHG-0041"] })));
    expect(plan.changeId).toBe("CHG-0042");
    expect(plan.files[1]?.content).toContain("## Problem\nx");
    expect(nextChangeId([])).toBe("CHG-0001");
  });

  it("refuses an empty title", () => {
    expect(createChange(loadRepo(baseTree()), { title: " ", kind: "feature", risk: "routine", origin: { type: "idea" } }, PO_CTX()).ok).toBe(false);
  });
});

describe("accept and sendBack", () => {
  it("gate 1 by the PO moves the change to stage 2 with intent committed (acceptance a)", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true, events: [ev("artifact.committed", AGENT, { artifact: 0, path: "intent.md", sha: SHA })] });
    const { repo, view } = viewOf(tree, "CHG-0001");
    const plan = expectOk(accept(repo, view, 1, PO_CTX()));
    expect(plan.files).toEqual([]);
    expect(plan.events.map((e) => [e.event.event, e.event.actor.type, e.event.seq])).toEqual([
      ["gate.accepted", "human", 2],
      ["stage.entered", "system", 3],
    ]);
    expect(plan.commitMessage).toBe("sdlc(CHG-0001): accept intent.md (gate 1)");
    const next = viewOf(applyWritePlan(tree, plan), "CHG-0001").view;
    expect(next.stage).toBe(2);
    expect(next.gate).toBeNull();
    expect(next.agent).toBe(true);
    expect(next.docs[0].state).toBe("committed");
    expect(next.status).toBe("Agent producing spec.md");
  });

  it("refuses the wrong role, a closed gate, the wrong gate and an unknown identity", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const { repo, view } = viewOf(tree, "CHG-0001");
    const eng = accept(repo, view, 1, ENG_CTX());
    expect(eng.ok).toBe(false);
    if (!eng.ok) expect(eng.diagnostics[0]?.rule).toBe("gate.not-owner");
    const wrong = accept(repo, view, 2, PO_CTX());
    if (!wrong.ok) expect(wrong.diagnostics[0]?.rule).toBe("gate.mismatch");
    const nobody = accept(repo, view, 1, ctxFor("stranger@example.com"));
    if (!nobody.ok) expect(nobody.diagnostics[0]?.rule).toBe("gate.not-owner");
    const noGate = viewOf(withChange(baseTree(), { id: "CHG-0002" }), "CHG-0002");
    const closed = accept(noGate.repo, noGate.view, 1, PO_CTX());
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.diagnostics[0]?.rule).toBe("gate.closed");
  });

  it("refuses when config is missing, so nobody can accept without declared identities", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const noConfig = { ...tree, files: new Map([...tree.files].filter(([p]) => p !== "sdlc/config.yaml")) };
    const { repo, view } = viewOf(noConfig, "CHG-0001");
    const r = accept(repo, view, 1, PO_CTX());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.rule).toBe("config.missing");
  });

  it("send-back needs feedback and re-enters revision without changing the stage (acceptance f)", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, events: [...acceptedThrough([1]), ev("artifact.committed", AGENT, { artifact: 1, path: "spec.md", sha: SHA })] });
    const { repo, view } = viewOf(tree, "CHG-0001");
    expect(sendBack(repo, view, 2, "  ", PO_CTX()).ok).toBe(false);
    const plan = expectOk(sendBack(repo, view, 2, "needs the export format", PO_CTX()));
    expect(plan.commitMessage).toBe("sdlc(CHG-0001): send back spec.md (gate 2)");
    const next = viewOf(applyWritePlan(tree, plan), "CHG-0001").view;
    expect(next.stage).toBe(2);
    expect(next.gate).toBeNull();
    expect(next.status).toBe("Agent revising spec.md per feedback");
  });

  it("gate 3 freezes the plan: accepted_by/accepted_at written, stage 4 entered", () => {
    const events = [...acceptedThrough([1, 2]), ev("artifact.committed", AGENT, { artifact: 2, path: "plan.md", sha: SHA }), ev("plan.final", AGENT, { rev: 1 })];
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"] }, events });
    const { repo, view } = viewOf(tree, "CHG-0001");
    const plan = expectOk(accept(repo, view, 3, ENG_CTX()));
    expect(plan.files[0]?.path).toBe("sdlc/changes/CHG-0001/plan.md");
    expect(plan.files[0]?.content).toContain("accepted_by: eng@example.com");
    expect(plan.files[0]?.content).toContain("accepted_at: 2026-09-04T09:00:00Z");
    const next = viewOf(applyWritePlan(tree, plan), "CHG-0001").view;
    expect(next.valid).toBe(true);
    expect(next.stage).toBe(4);
    expect(next.planState).toBe("committed");
    expect(next.docs[2].state).toBe("committed");
  });

  it("high-risk gate 3: the engineer cannot accept; the tech lead can in local mode", () => {
    const events = [...acceptedThrough([1, 2]), ev("artifact.committed", AGENT, { artifact: 2, path: "plan.md", sha: SHA }), ev("plan.final", AGENT, { rev: 1 })];
    const tree = withChange(baseTree(), { id: "CHG-0001", risk: "high", intent: true, spec: true, plan: true, events });
    const { repo, view } = viewOf(tree, "CHG-0001");
    const engOnly = accept(repo, view, 3, ctxFor("po@example.com"));
    expect(engOnly.ok).toBe(false);
    const plan = expectOk(accept(repo, view, 3, ENG_CTX())); // eng@example.com also holds tech_lead in the fixture
    expect(plan.events[0]?.event.actor).toMatchObject({ role: "tech_lead" });
    const next = viewOf(applyWritePlan(tree, plan), "CHG-0001").view;
    expect(next.valid).toBe(true);
    expect(next.stage).toBe(4);
  });

  it("gate 5 needs the merge sha and records pr.merged; stage 6 follows", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], pr: {}, events: acceptedThrough([1, 2, 3]) });
    const { repo, view } = viewOf(tree, "CHG-0001");
    expect(view.gate?.s).toBe(5);
    const noSha = accept(repo, view, 5, ENG_CTX());
    expect(noSha.ok).toBe(false);
    const plan = expectOk(accept(repo, view, 5, ctxFor("eng@example.com", { mergeSha: SHA })));
    expect(plan.files[0]?.content).toContain(`mergeSha: ${SHA}`);
    expect(plan.events.map((e) => e.event.event)).toEqual(["gate.accepted", "pr.merged", "stage.entered"]);
    const next = viewOf(applyWritePlan(tree, plan), "CHG-0001").view;
    expect(next.stage).toBe(6);
    expect(next.status).toBe("Deployed · monitoring");
  });

  it("linked-mode artifact without a record blocks accept", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const linked = { ...tree, files: new Map(tree.files) };
    const cfg = linked.files.get("sdlc/config.yaml")?.content ?? "";
    linked.files.set("sdlc/config.yaml", { content: `${cfg}records: { intent: linked }\n`, sha: "x".repeat(40) });
    const { repo, view } = viewOf(linked, "CHG-0001");
    const r = accept(repo, view, 1, PO_CTX());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.rule).toBe("gate.linked.record-missing");
  });
});

describe("loop (gate 6, acceptance b)", () => {
  it("archives the cycle, seeds the intent from the incident, drafts an INC case and re-enters stage 1", () => {
    const events = [...acceptedThrough([1, 2, 3]), ev("pr.merged", SYSTEM, { mergeSha: SHA }), ev("artifact.committed", AGENT, { artifact: 5, path: "incident.md", sha: SHA })];
    const tree = withChange(baseTree(), { id: "CHG-0012", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], pr: { merged: true }, incident: true, events });
    const { repo, view } = viewOf(tree, "CHG-0012");
    expect(view.gate?.s).toBe(6);
    expect(accept(repo, view, 6, ENG_CTX()).ok).toBe(false);
    const plan = expectOk(accept(repo, view, 6, PO_CTX()));
    expect(plan.commitMessage).toBe("sdlc(CHG-0012): accept incident.md (gate 6) → cycle 2");
    const deleted = plan.files.filter((f) => f.content === null).map((f) => f.path);
    expect(deleted).toEqual(expect.arrayContaining(["sdlc/changes/CHG-0012/intent.md", "sdlc/changes/CHG-0012/spec.md", "sdlc/changes/CHG-0012/plan.md", "sdlc/changes/CHG-0012/pr.yaml", "sdlc/changes/CHG-0012/incident.md", "sdlc/changes/CHG-0012/evals/run-1.json"]));
    expect(plan.files.map((f) => f.path)).toContain("sdlc/changes/CHG-0012/cycles/1/incident.md");
    expect(plan.files.map((f) => f.path)).toContain("evals/cases/INC-CHG-0012-1.json");
    expect(plan.events.map((e) => [e.event.event, e.event.cycle])).toEqual([
      ["gate.accepted", 1],
      ["cycle.archived", 2],
      ["artifact.committed", 2],
      ["stage.entered", 2],
    ]);

    const after = applyWritePlan(tree, plan);
    const next = viewOf(after, "CHG-0012");
    expect(next.view.valid).toBe(true);
    expect(next.view.cycle).toBe(2);
    expect(next.view.kind).toBe("fix");
    expect(next.view.stage).toBe(1);
    // seeded intent carries a placeholder Constraints section → gate closed, loop status shown
    expect(next.view.gate).toBeNull();
    expect(next.view.status).toBe("Loop closed — re-entered Plan from incident");
    expect(next.view.agent).toBe(true);
    expect(next.view.docs[0].state).toBe("draft");
    expect(next.view.docs[5].state).toBe("absent");
    expect(next.repo.evalCases.find((c) => c.id === "INC-CHG-0012-1")).toMatchObject({ status: "draft", source: { type: "incident", ref: "CHG-0012" }, paths: ["src/a.ts"] });
    expect(after.files.get("sdlc/changes/CHG-0012/intent.md")?.content).toContain("## Problem\nfilled");
    expect(after.files.has("sdlc/changes/CHG-0012/cycles/1/plan.md")).toBe(true);
    expect(next.repo.changes.get("CHG-0012")?.archivedCycles).toEqual([1]);
  });

  it("maps incident sections onto the intent template", () => {
    const body = "# Incident: Outage\n\n## Anomaly and evidence\nerrors 5x\n\n## Proposed outcome\nno errors\n\n## Affected systems\napi\n\n## Open questions\nwhy\n";
    const intent = intentFromIncident("Outage", body);
    expect(intent).toContain("# Intent: Outage");
    expect(intent).toContain("## Problem\nerrors 5x");
    expect(intent).toContain("## Affected users and systems\napi");
    expect(intent).toContain("## Open questions\nwhy");
  });
});

describe("tasks", () => {
  it("proposes one task per directory with the acceptance line as target", () => {
    const t = proposeTasks(["src/a.ts", "src/b.ts", "test/a.test.ts", "README.md"], "tests pass");
    expect(t.map((x) => [x.id, x.files.length, x.target])).toEqual([
      ["src", 2, "tests pass"],
      ["test", 1, "tests pass"],
      ["root", 1, "tests pass"],
    ]);
  });
  it("merges overlapping file sets into one sequential task", () => {
    const merged = mergeOverlaps([
      { id: "a", title: "A", files: ["x", "y"] },
      { id: "b", title: "B", files: ["y", "z"] },
      { id: "c", title: "C", files: ["w"] },
    ]);
    expect(merged.map((m) => [m.id, m.sequential, m.files])).toEqual([
      ["a+b", true, ["x", "y", "z"]],
      ["c", false, ["w"]],
    ]);
    expect(merged[0]?.title).toContain("sequential · shared files: y");
  });
  it("confirmTasks writes tasks.yaml with worktree names and needs the engineer at stage 4", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts", "test/a.test.ts"], accepted: true }, events: acceptedThrough([1, 2, 3]) });
    const { repo, view } = viewOf(tree, "CHG-0001");
    expect(confirmTasks(repo, view, proposeTasks(view.planFiles, view.acceptanceLine), PO_CTX()).ok).toBe(false);
    const plan = expectOk(confirmTasks(repo, view, proposeTasks(view.planFiles, view.acceptanceLine), ENG_CTX()));
    expect(plan.files[0]?.path).toBe("sdlc/changes/CHG-0001/tasks.yaml");
    expect(plan.files[0]?.content).toContain("worktree: CHG-0001/src");
    const next = viewOf(applyWritePlan(tree, plan), "CHG-0001").view;
    expect(next.valid).toBe(true);
    expect(next.tasks.map((t) => [t.id, t.state, t.branch])).toEqual([
      ["src", "confirmed", "CHG-0001/src"],
      ["test", "confirmed", "CHG-0001/test"],
    ]);
    const early = viewOf(withChange(baseTree(), { id: "CHG-0002", intent: true }), "CHG-0002");
    expect(confirmTasks(early.repo, early.view, [{ title: "t", files: ["a"] }], ENG_CTX()).ok).toBe(false);
  });
});

describe("confirmRepro (acceptance k)", () => {
  it("records the repro block, writes repro.json and logs repro.confirmed for a fix change at stage 4", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", kind: "fix", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: acceptedThrough([1, 2, 3]) });
    const { repo, view } = viewOf(tree, "CHG-0001");
    const input = { testPath: "test/a.test.ts", failureReason: "expected 200, received 500", sha: SHA, output: "AssertionError" };
    expect(confirmRepro(repo, view, input, PO_CTX()).ok).toBe(false);
    const plan = expectOk(confirmRepro(repo, view, input, ENG_CTX()));
    expect(plan.files.map((f) => f.path)).toEqual(["sdlc/changes/CHG-0001/change.yaml", "sdlc/changes/CHG-0001/evals/repro.json"]);
    const after = applyWritePlan(tree, plan);
    const next = viewOf(after, "CHG-0001");
    expect(next.view.valid).toBe(true);
    expect(next.view.repro).toEqual({ state: "committed", testPath: "test/a.test.ts", failureReason: "expected 200, received 500", sha: SHA });
    expect(next.repo.changes.get("CHG-0001")?.repro?.confirmedBy).toBe("eng@example.com");
    expect(confirmRepro(next.repo, next.view, input, ENG_CTX()).ok).toBe(false);
  });
  it("refuses for feature changes", () => {
    const tree = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, events: acceptedThrough([1, 2, 3]) });
    const { repo, view } = viewOf(tree, "CHG-0001");
    const r = confirmRepro(repo, view, { testPath: "t", failureReason: "r", sha: SHA, output: "" }, ENG_CTX());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.rule).toBe("repro.not-fix");
  });
});

describe("triage and finding routing", () => {
  const triageTree = () =>
    withFilesT(baseTree(), {
      "sdlc/loop/triage/TRI-0042.md": "---\nschema: 1\nid: TRI-0042\ntier: 3σ\nsrc: metric:p95\ntitle: Slow export\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: open\n---\n# Intent: Slow export\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Affected users and systems\na\n\n## Constraints\nc\n\n## Open questions\nq\n",
      "sdlc/security/findings/SEC-0118.yaml": "schema: 1\nid: SEC-0118\nscannerId: s\nsev: high\nconf: 0.9\nrepo: invoicing\ntitle: SQL injection\ndesc: d\nstatus: new\n",
    });
  it("acceptTriage creates the change from the item body and removes the item", () => {
    const tree = triageTree();
    const repo = loadRepo(tree);
    expect(acceptTriage(repo, "TRI-0042", ENG_CTX()).ok).toBe(false);
    const plan = expectOk(acceptTriage(repo, "TRI-0042", PO_CTX()));
    expect(plan.files.some((f) => f.path === "sdlc/loop/triage/TRI-0042.md" && f.content === null)).toBe(true);
    const after = loadRepo(applyWritePlan(tree, plan));
    expect(after.triage).toEqual([]);
    expect(viewOf(after.tree, "CHG-0001").view).toMatchObject({ stage: 1, origin: { type: "triage", ref: "TRI-0042" }, status: "Intent drafted via TRI-0042" });
    expect(dismissTriage(after, "TRI-0042", "gone", PO_CTX()).ok).toBe(false);
  });
  it("dismissTriage needs a reason and keeps the file as history", () => {
    const tree = triageTree();
    const repo = loadRepo(tree);
    expect(dismissTriage(repo, "TRI-0042", " ", PO_CTX()).ok).toBe(false);
    const plan = expectOk(dismissTriage(repo, "TRI-0042", "noise after deploy", PO_CTX(), "raise 3σ to 4σ"));
    expect(plan.changeId).toBeNull();
    const after = loadRepo(applyWritePlan(tree, plan));
    expect(after.triage[0]?.data).toMatchObject({ status: "dismissed", dismissal: { by: "po@example.com", reason: "noise after deploy", bandTune: "raise 3σ to 4σ" } });
  });
  it("patch / escalate / dismiss a finding", () => {
    const tree = triageTree();
    const repo = loadRepo(tree);
    expect(patchFinding(repo, "SEC-0118", PO_CTX()).ok).toBe(false);
    const patched = loadRepo(applyWritePlan(tree, expectOk(patchFinding(repo, "SEC-0118", ENG_CTX(), { number: 12 }))));
    expect(patched.findings[0]).toMatchObject({ status: "patch_pr", patchPr: { number: 12 } });
    expect(escalateFinding(patched, "SEC-0118", ENG_CTX()).ok).toBe(false);

    const escalated = loadRepo(applyWritePlan(tree, expectOk(escalateFinding(repo, "SEC-0118", ENG_CTX()))));
    expect(escalated.findings[0]).toMatchObject({ status: "escalated", escalatedTo: "CHG-0001" });
    expect(viewOf(escalated.tree, "CHG-0001").view).toMatchObject({ kind: "fix", risk: "high", origin: { type: "security", ref: "SEC-0118" } });
    expect(escalated.evalCases.map((c) => c.id)).toEqual(["CASE-SEC-0118"]);

    expect(dismissFinding(repo, "SEC-0118", "", ENG_CTX()).ok).toBe(false);
    const dismissed = loadRepo(applyWritePlan(tree, expectOk(dismissFinding(repo, "SEC-0118", "false positive: parameterised", ENG_CTX()))));
    expect(dismissed.findings[0]).toMatchObject({ status: "dismissed", dismissal: { reason: "false positive: parameterised" } });
  });
});

describe("importFindings", () => {
  it("allocates ids for new scanner ids, updates known ones, keeps dismissed dismissed", () => {
    const tree = withFilesT(baseTree(), {
      "sdlc/security/findings/SEC-0118.yaml": "schema: 1\nid: SEC-0118\nscannerId: cs:1\nsev: high\nconf: 0.9\nrepo: invoicing\ntitle: SQL injection\ndesc: d\nstatus: dismissed\ndismissal: { by: eng@example.com, reason: parameterised }\n",
    });
    const repo = loadRepo(tree);
    const rows = [
      { scannerId: "cs:1", sev: "high" as const, conf: 0.95, repo: "invoicing", title: "SQL injection", desc: "still reported" },
      { scannerId: "cs:2", sev: "low" as const, conf: 0.5, repo: "invoicing", title: "Verbose errors", desc: "" },
    ];
    expect(importFindings(repo, rows, PO_CTX()).ok).toBe(false);
    const plan = expectOk(importFindings(repo, rows, ENG_CTX()));
    expect(plan.commitMessage).toBe("sdlc(security): import 1 new finding, 1 updated");
    const after = loadRepo(applyWritePlan(tree, plan));
    expect(after.findings.map((f) => [f.id, f.scannerId, f.status])).toEqual([["SEC-0118", "cs:1", "dismissed"], ["SEC-0119", "cs:2", "new"]]);
    expect(after.findings[0]?.desc).toBe("still reported");
    expect(importFindings(after, rows, ENG_CTX()).ok).toBe(false);
  });
});

describe("dismissProposal", () => {
  it("needs a reason and an owner; keeps the proposal as history", () => {
    const tree = withFilesT(baseTree(), { "sdlc/proposals/PRP-0007.yaml": "schema: 1\nid: PRP-0007\ntype: claude-md-line\ntext: Never filter by truthiness.\ncitations: [CHG-0018]\nstatus: open\ncreatedAt: 2026-09-02T09:40:00Z\n" });
    const repo = loadRepo(tree);
    expect(dismissProposal(repo, "PRP-0007", "already covered by lint", PO_CTX()).ok).toBe(false);
    expect(dismissProposal(repo, "PRP-0007", " ", ENG_CTX()).ok).toBe(false);
    const plan = expectOk(dismissProposal(repo, "PRP-0007", "already covered by lint", ENG_CTX()));
    const after = loadRepo(applyWritePlan(tree, plan));
    expect(after.proposals[0]).toMatchObject({ status: "dismissed", dismissal: { by: "eng@example.com", reason: "already covered by lint" } });
    expect(dismissProposal(after, "PRP-0007", "again", ENG_CTX()).ok).toBe(false);
  });
});

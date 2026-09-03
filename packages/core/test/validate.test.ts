import { beforeEach, describe, expect, it } from "vitest";
import { accept, applyWritePlan, loadRepo, validateChange, validateDiff, validateIds, validateTree, validateWritePlan, withFiles, type Tree, type WritePlan } from "../src/index.js";
import { AGENT, PO, SHA, SYSTEM, acceptedThrough, baseTree, changeFiles, ev, resetSeq, viewOf, withChange } from "./helpers.js";

const loadView = (repo: ReturnType<typeof loadRepo>, id: string) => viewOf(repo.tree, id).view;

beforeEach(resetSeq);

const rules = (t: Tree) => validateTree(loadRepo(t)).diagnostics.map((d) => [d.rule, d.blocking] as const);
const blockingRules = (t: Tree) => validateTree(loadRepo(t)).diagnostics.filter((d) => d.blocking).map((d) => d.rule);

describe("validateTree", () => {
  it("a clean tree has nothing blocking (suite size is only advisory)", () => {
    const t = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const r = validateTree(loadRepo(t));
    expect(r.blocking).toBe(false);
    expect(r.diagnostics.map((d) => d.rule)).toEqual(["eval-suite.under-sized"]);
  });

  it("schema and parse errors block and are attributed to the change", () => {
    const t = withFiles(baseTree(), { "sdlc/changes/CHG-0009/change.yaml": "schema: 1\nid: CHG-0009\nstage: 3\n" });
    const r = validateTree(loadRepo(t));
    expect(r.blocking).toBe(true);
    expect(r.byChange["CHG-0009"]).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.rule === "schema.change" && d.message.includes("stage"))).toBe(true);
  });

  it("an open gate on an incomplete artifact blocks", () => {
    const files = changeFiles(baseTree(), { id: "CHG-0001", intent: true });
    files["sdlc/changes/CHG-0001/intent.md"] = (files["sdlc/changes/CHG-0001/intent.md"] ?? "").replace("## Constraints\nfilled\n", "## Constraints\n<tbd>\n");
    const t = withFiles(baseTree(), files);
    expect(blockingRules(t)).toContain("gate.artifact-incomplete");
    const repo = loadRepo(t);
    expect(validateChange(repo, "CHG-0001").blocking).toBe(true);
    const r = accept(repo, loadView(repo, "CHG-0001"), 1, { now: "2026-09-04T09:00:00Z", newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9TA", actor: { id: "po@example.com" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.rule).toBe("gate.artifact-incomplete");
  });

  it("SHA chaining: spec.intent_sha must equal the accepted intent's sha; plan.spec_sha the accepted spec's", () => {
    const events = [
      ev("artifact.committed", AGENT, { artifact: 0, path: "intent.md", sha: SHA }),
      ev("gate.accepted", PO, { gate: 1, artifactSha: "f".repeat(40), source: "cli" }),
    ];
    const t = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, events });
    const r = rules(t);
    expect(r).toContainEqual(["chain.spec.intent_sha", true]);
    expect(r).toContainEqual(["chain.intent.modified", false]);
    const good = withChange(baseTree(), { id: "CHG-0002", intent: true, spec: true, events: [ev("gate.accepted", PO, { gate: 1, artifactSha: SHA, source: "cli" })] });
    expect(blockingRules(good)).not.toContain("chain.spec.intent_sha");
  });

  it("gate actor must hold the owning role even when the event is well-formed", () => {
    const events = [ev("gate.accepted", { type: "human", id: "eng@example.com", role: "po" }, { gate: 1, artifactSha: SHA, source: "cli" })];
    const t = withChange(baseTree(), { id: "CHG-0001", intent: true, events });
    expect(blockingRules(t)).toContain("gate.actor-not-owner");
  });

  it("linked-mode artifact accepted without a record blocks", () => {
    const t0 = withChange(baseTree(), { id: "CHG-0001", intent: true, events: acceptedThrough([1]) });
    const cfg = t0.files.get("sdlc/config.yaml")?.content ?? "";
    const t = withFiles(t0, { "sdlc/config.yaml": `${cfg}records: { intent: linked }\n` });
    expect(blockingRules(t)).toContain("linked.record-missing");
  });

  it("non-sequential tasks may not overlap; running tasks need a target", () => {
    const t = withFiles(withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["a"], accepted: true }, events: acceptedThrough([1, 2, 3]) }), {
      "sdlc/changes/CHG-0001/tasks.yaml": "schema: 1\nchangeId: CHG-0001\ncycle: 1\ntasks:\n  - { id: a, title: A, files: [x], sequential: false, state: running }\n  - { id: b, title: B, files: [x], sequential: false, state: confirmed }\n",
    });
    const r = blockingRules(t);
    expect(r).toContain("tasks.files.overlap");
    expect(r).toContain("tasks.target.missing");
  });

  it("active eval case without checks blocks; dismissed items need a reason", () => {
    const t = withFiles(baseTree(), {
      "evals/cases/CASE-0001.json": JSON.stringify({ schema: 1, id: "CASE-0001", prompt: "p", checks: [], source: { type: "manual" }, owner: "o", added: "2026-09-03T10:00:00Z", status: "active", paths: [] }),
      "sdlc/security/findings/SEC-0001.yaml": "schema: 1\nid: SEC-0001\nscannerId: s\nsev: low\nconf: 0.5\nrepo: r\ntitle: t\ndesc: d\nstatus: dismissed\n",
      "sdlc/loop/triage/TRI-0001.md": "---\nschema: 1\nid: TRI-0001\ntier: incident\nsrc: s\ntitle: t\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: dismissed\n---\nb\n",
    });
    const r = blockingRules(t);
    expect(r).toContain("eval-case.active-without-checks");
    expect(r.filter((x) => x === "dismissal.reason-missing")).toHaveLength(2);
  });

  it("a looped change past stage 4 with an inactive INC case blocks; derive holds it at 4 (acceptance n)", () => {
    const events = [...acceptedThrough([1, 2, 3, 6], 1), ev("cycle.archived", SYSTEM, { cycle: 1, into: "cycles/1" }, 2), ...acceptedThrough([1, 2, 3], 2)];
    const t = withChange(baseTree(), { id: "CHG-0012", cycle: 2, intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], events });
    const draft = withFiles(t, { "evals/cases/INC-CHG-0012-1.json": JSON.stringify({ schema: 1, id: "INC-CHG-0012-1", prompt: "p", checks: [], source: { type: "incident", ref: "CHG-0012" }, owner: "o", added: "2026-09-03T10:00:00Z", status: "draft", paths: [] }) });
    const repo = loadRepo(draft);
    const view = loadView(repo, "CHG-0012");
    expect(view.stage).toBe(4);
    expect(view.evalsState).toBe("inc-blocked");
    expect(view.status).toBe("Evals green — activate INC-CHG-0012-1 before Test can pass");
    expect(validateTree(repo).blocking).toBe(false);

    const active = withFiles(t, { "evals/cases/INC-CHG-0012-1.json": JSON.stringify({ schema: 1, id: "INC-CHG-0012-1", prompt: "p", checks: [{ name: "t", cmd: "x" }], source: { type: "incident", ref: "CHG-0012" }, owner: "o", added: "2026-09-03T10:00:00Z", status: "active", paths: [] }), ...changeFiles(t, { id: "CHG-0012", cycle: 2, intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, runs: ["green"], pr: {}, events }) });
    expect(loadView(loadRepo(active), "CHG-0012").stage).toBe(5);
  });
});

describe("validateDiff", () => {
  it("risk and kind are immutable at stage ≥ 3; archived cycles and the ledger are append-only", () => {
    const before = withChange(baseTree(), { id: "CHG-0001", intent: true, spec: true, plan: true, events: acceptedThrough([1, 2]) });
    resetSeq(); // same ids and seqs → only risk/kind differ
    const changed = changeFiles(before, { id: "CHG-0001", risk: "high", kind: "fix", intent: true, spec: true, plan: true, events: acceptedThrough([1, 2]) });
    const after = withFiles(before, changed);
    const r = validateDiff(loadRepo(before), loadRepo(after));
    expect(r.diagnostics.map((d) => d.rule).sort()).toEqual(["change.kind.immutable", "change.risk.immutable"]);

    const early = withChange(baseTree(), { id: "CHG-0002", intent: true });
    const earlyChanged = withFiles(early, changeFiles(early, { id: "CHG-0002", risk: "high", intent: true }));
    expect(validateDiff(loadRepo(early), loadRepo(earlyChanged)).blocking).toBe(false);

    const removed = { ...before, files: new Map([...before.files].filter(([p]) => !p.includes("CHG-0001"))) };
    expect(validateDiff(loadRepo(before), loadRepo(removed)).diagnostics.map((d) => d.rule)).toContain("change.removed");

    const rewritten = withFiles(before, { "sdlc/changes/CHG-0001/log.jsonl": "" });
    expect(validateDiff(loadRepo(before), loadRepo(rewritten)).diagnostics.map((d) => d.rule)).toContain("log.event.removed");
  });
});

describe("validateIds", () => {
  it("flags ids created independently on two branches, not ids that also exist on main", () => {
    const r = validateIds({ main: ["CHG-0001"], "feature/a": ["CHG-0001", "CHG-0002"], "feature/b": ["CHG-0002"] });
    expect(r.diagnostics.map((d) => d.changeId)).toEqual(["CHG-0002"]);
  });
});

describe("validateWritePlan", () => {
  it("rejects a hand-built plan carrying an agent-authored gate.accepted", () => {
    const t = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const repo = loadRepo(t);
    const plan: WritePlan = {
      changeId: "CHG-0001",
      files: [],
      events: [{ changeId: "CHG-0001", event: ev("gate.accepted", PO, { gate: 1, artifactSha: SHA, source: "cli" }) }],
      commitMessage: "x",
      trailers: {},
      actor: PO,
    };
    const first = plan.events[0];
    if (!first) throw new Error("no event");
    const forged = { ...plan, events: [{ changeId: "CHG-0001", event: { ...first.event, actor: AGENT } as never }] };
    expect(validateWritePlan(repo, plan).blocking).toBe(false);
    const r = validateWritePlan(repo, forged);
    expect(r.blocking).toBe(true);
    expect(r.diagnostics.some((d) => d.pointer === "/actor/type")).toBe(true);
  });

  it("a real accept plan validates clean and the applied tree derives to stage 2", () => {
    const t = withChange(baseTree(), { id: "CHG-0001", intent: true });
    const repo = loadRepo(t);
    const r = accept(repo, loadView(repo, "CHG-0001"), 1, { now: "2026-09-04T09:00:00Z", newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9TB", actor: { id: "po@example.com" } });
    if (!r.ok) throw new Error("accept failed");
    expect(validateWritePlan(repo, r.plan).blocking).toBe(false);
    expect(loadView(loadRepo(applyWritePlan(t, r.plan)), "CHG-0001").stage).toBe(2);
  });
});


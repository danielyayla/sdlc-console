import { describe, expect, it } from "vitest";
import { seedTree } from "@sdlc/fixtures";
import {
  accept,
  applyWritePlan,
  commitWrittenBack,
  deriveChange,
  effectiveMode,
  linkRecord,
  loadRepo,
  pendingWritebacks,
  recordWriteback,
  repoRules,
  requiredWritebacks,
  syncedAt,
  withFiles,
  type TransitionContext,
  type TransitionResult,
  type Tree,
} from "../src/index.js";
import { AGENT, SHA, acceptedThrough, baseTree, ev, resetSeq, viewOf, withChange } from "./helpers.js";

let n = 0;
const ctxFor = (actorId: string): TransitionContext => ({
  now: "2026-09-04T09:00:00Z",
  newId: () => `01J8Z6Q7Y2K3M4N5P6Q7R8S${(++n).toString(36).toUpperCase().padStart(3, "0")}`.replace(/[ILOU]/g, "X"),
  actor: { id: actorId },
});
const PO_CTX = () => ctxFor("po@example.com");

function plan(r: TransitionResult) {
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
}
function refusal(r: TransitionResult): string {
  if (r.ok) throw new Error("expected a refusal");
  return r.diagnostics[0]?.rule ?? "";
}

/** The base tree with `records.intent` set and CHG-0001's change.yaml carrying a record (or not). */
function recordsTree(mode: "external" | "linked", opts: { record?: boolean; events?: ReturnType<typeof ev>[]; connector?: boolean } = {}): Tree {
  resetSeq();
  const t0 = baseTree();
  const cfg = t0.files.get("sdlc/config.yaml")?.content ?? "";
  const t1 = withFiles(t0, { "sdlc/config.yaml": `${cfg}records: { intent: ${mode}${opts.connector === false ? "" : ", connector: records"} }\n` });
  const t2 = withChange(t1, { id: "CHG-0001", intent: true, events: opts.events ?? [ev("artifact.committed", AGENT, { artifact: 0, path: "sdlc/changes/CHG-0001/intent.md", sha: SHA })] });
  if (opts.record === false) return t2;
  const change = t2.files.get("sdlc/changes/CHG-0001/change.yaml")?.content ?? "";
  expect(change).toContain("record: null");
  return withFiles(t2, { "sdlc/changes/CHG-0001/change.yaml": change.replace("record: null", "record:\n  system: jira\n  id: JIRA-1\n  url: https://jira.example/browse/JIRA-1") });
}

describe("records mode (2.9, FR-16): derived write-backs and sync state", () => {
  it("the seed's incident is external: one committed write-back already ok, synced at its time, nothing pending, and the connector is configured", () => {
    const repo = loadRepo(seedTree());
    const files = repo.changes.get("CHG-0012");
    if (!files) throw new Error("CHG-0012 missing");
    const required = requiredWritebacks(repo, files);
    expect(required.map((w) => [w.artifact, w.kind, w.state, w.record.id, w.url])).toEqual([[5, "committed", "ok", "INC0041207", "https://servicenow.example/incident/INC0041207#work-notes"]]);
    expect(syncedAt(files, 5)).toBe("2026-09-02T07:31:00Z");
    const view = deriveChange(repo, files);
    expect(view.docs[5].record).toEqual({ artifactName: "incident", mode: "external", chip: "servicenow INC0041207", url: "https://servicenow.example/incident/INC0041207", syncedAt: "2026-09-02T07:31:00Z", writeback: { kind: "committed", sha: required[0]?.sha, state: "ok", at: "2026-09-02T07:31:00Z", error: null } });
    expect(view.docs[5].authoritative).toBe(false);
    expect(view.docs[0].record).toMatchObject({ mode: "repo", chip: "servicenow INC0041207", syncedAt: null, writeback: null });
    expect(view.recordBlock).toBeNull();
    expect(pendingWritebacks(repo)).toEqual([]);
    expect(repo.config.recordsConnector).toBe("records");
    expect(repoRules(repo).map((d) => d.rule)).not.toContain("records.connector-missing");
    // CHG-0017 carries its Jira record on repo-mode artifacts: a chip, no write-backs
    const c17 = repo.changes.get("CHG-0017");
    if (!c17) throw new Error("CHG-0017 missing");
    expect(requiredWritebacks(repo, c17)).toEqual([]);
    expect(deriveChange(repo, c17).docs[0].record.chip).toBe("jira JIRA-4411");
  });

  it("validation warns when external or linked artifacts have no connector, and when evals/pr are linked (they behave as external)", () => {
    const seed = seedTree();
    const cfg = seed.files.get("sdlc/config.yaml")?.content ?? "";
    expect(cfg).toContain("connector: records");
    const noConnector = loadRepo(withFiles(seed, { "sdlc/config.yaml": cfg.replace("  connector: records\n", "").replace("pr: repo", "pr: linked") }));
    const rules = repoRules(noConnector).map((d) => [d.rule, d.severity]);
    expect(rules).toContainEqual(["records.connector-missing", "warning"]);
    expect(rules).toContainEqual(["records.linked-unsupported", "warning"]);
    expect(noConnector.config.recordsConnector).toBeNull();
    expect(effectiveMode(noConnector, "pr")).toBe("external");
    expect(effectiveMode(noConnector, "incident")).toBe("external");
  });

  it("external mode: a committed then accepted artifact calls for two write-backs; outcomes move them pending → failed → ok, a repeat ok is refused, and repo-mode artifacts never write back", () => {
    const tree = recordsTree("external", { events: acceptedThrough([1]) });
    const { repo, files, view } = viewOf(tree, "CHG-0001");
    const required = requiredWritebacks(repo, files);
    expect(required.map((w) => [w.kind, w.sha, w.state, w.mode])).toEqual([["committed", SHA, "pending", "external"], ["accepted", SHA, "pending", "external"]]);
    expect(pendingWritebacks(repo).map((w) => `${w.changeId}:${w.artifact}:${w.kind}`)).toEqual(["CHG-0001:0:committed", "CHG-0001:0:accepted"]);
    expect(view.docs[0].record).toMatchObject({ mode: "external", chip: "jira JIRA-1", syncedAt: null, writeback: { kind: "accepted", state: "pending" } });
    expect(view.docs[0].authoritative).toBe(false);
    expect(view.recordBlock).toBeNull();

    // the connector refused the accept write-back
    const failed = plan(recordWriteback(repo, view, { artifact: 0, kind: "accepted", sha: SHA, ok: false, error: "503 from the records API" }, ctxFor("sdlc-bot")));
    expect(failed.actor).toEqual({ type: "system", id: "sdlc-bot" });
    expect(failed.commitMessage).toBe("sdlc(CHG-0001): write-back failed — intent.md accepted 0123456 → jira JIRA-1");
    const t1 = applyWritePlan(tree, failed);
    const v1 = viewOf(t1, "CHG-0001");
    expect(requiredWritebacks(v1.repo, v1.files).map((w) => [w.kind, w.state, w.error])).toEqual([["committed", "pending", null], ["accepted", "failed", "503 from the records API"]]);
    expect(v1.view.docs[0].record.writeback).toMatchObject({ kind: "accepted", state: "failed", error: "503 from the records API" });
    expect(v1.view.activity.some((a) => a.text.includes("write-back of accepted 0123456 to jira JIRA-1 failed · retry"))).toBe(true);

    // the retry landed, and the committed one too
    const ok = plan(recordWriteback(v1.repo, v1.view, { artifact: 0, kind: "accepted", sha: SHA, ok: true, url: "https://jira.example/browse/JIRA-1#accepted" }, ctxFor("sdlc-bot")));
    expect(ok.commitMessage).toBe("sdlc(CHG-0001): write-back ok — intent.md accepted 0123456 → jira JIRA-1");
    const t2 = applyWritePlan(t1, ok);
    const v2 = viewOf(t2, "CHG-0001");
    const committed = plan(recordWriteback(v2.repo, v2.view, { artifact: 0, kind: "committed", sha: SHA, ok: true }, ctxFor("sdlc-bot")));
    const v3 = viewOf(applyWritePlan(t2, committed), "CHG-0001");
    expect(requiredWritebacks(v3.repo, v3.files).map((w) => [w.kind, w.state, w.url])).toEqual([["committed", "ok", null], ["accepted", "ok", "https://jira.example/browse/JIRA-1#accepted"]]);
    expect(v3.view.docs[0].record.syncedAt).toBe("2026-09-04T09:00:00Z");
    expect(pendingWritebacks(v3.repo)).toEqual([]);
    expect(refusal(recordWriteback(v3.repo, v3.view, { artifact: 0, kind: "accepted", sha: SHA, ok: true }, ctxFor("sdlc-bot")))).toBe("writeback.recorded");
    expect(refusal(recordWriteback(v3.repo, v3.view, { artifact: 1, kind: "committed", sha: SHA, ok: true }, ctxFor("sdlc-bot")))).toBe("writeback.repo-mode");

    // no record: nothing is owed and nothing can be recorded
    const bare = viewOf(recordsTree("external", { record: false, events: acceptedThrough([1]) }), "CHG-0001");
    expect(requiredWritebacks(bare.repo, bare.files)).toEqual([]);
    expect(bare.view.docs[0].record).toMatchObject({ mode: "external", chip: null, writeback: null });
    expect(refusal(recordWriteback(bare.repo, bare.view, { artifact: 0, kind: "accepted", sha: SHA, ok: true }, ctxFor("sdlc-bot")))).toBe("writeback.record-missing");
  });

  it("linked mode: accept is blocked until the record is linked and the artifact's commit was written back; linking is a human, once", () => {
    // the ledger's commit sha must be the intent's blob sha, as the launcher records it
    const probe = viewOf(recordsTree("linked", { record: false }), "CHG-0001");
    const blob = probe.view.docs[0].sha;
    if (!blob) throw new Error("intent sha missing");
    const t0 = recordsTree("linked", { record: false, events: [ev("artifact.committed", AGENT, { artifact: 0, path: "sdlc/changes/CHG-0001/intent.md", sha: blob })] });
    const v0 = viewOf(t0, "CHG-0001");
    expect(v0.view.gate?.s).toBe(1);
    expect(refusal(accept(v0.repo, v0.view, 1, PO_CTX()))).toBe("gate.linked.record-missing");
    expect(v0.view.recordBlock).toBe("Accept is blocked until intent.md is linked to its external record — link the record first");
    expect(v0.view.docs[0].record).toMatchObject({ mode: "linked", chip: null });
    expect(v0.view.docs[0].authoritative).toBe(false);

    expect(refusal(linkRecord(v0.repo, v0.view, { system: "jira", id: "JIRA-1" }, ctxFor("nobody@example.com")))).toBe("record.not-owner");
    expect(refusal(linkRecord(v0.repo, v0.view, { system: " ", id: "JIRA-1" }, PO_CTX()))).toBe("record.ref-missing");
    const link = plan(linkRecord(v0.repo, v0.view, { system: "jira", id: "JIRA-1", url: "https://jira.example/browse/JIRA-1" }, PO_CTX()));
    expect(link.commitMessage).toBe("sdlc(CHG-0001): link record jira JIRA-1");
    expect(link.files.map((f) => f.path)).toEqual(["sdlc/changes/CHG-0001/change.yaml"]);
    expect(link.files[0]?.content).toContain("id: JIRA-1");
    expect(link.events[0]?.event.event).toBe("record.linked");
    expect(link.events[0]?.event.actor).toEqual({ type: "human", id: "po@example.com", role: "po" });
    const t1 = applyWritePlan(t0, link);
    const v1 = viewOf(t1, "CHG-0001");
    expect(v1.view.record).toEqual({ system: "jira", id: "JIRA-1", url: "https://jira.example/browse/JIRA-1" });
    expect(refusal(linkRecord(v1.repo, v1.view, { system: "jira", id: "JIRA-2" }, PO_CTX()))).toBe("record.exists");

    // linked, but the commit is not on the record yet
    const sha = v1.view.docs[0].sha;
    if (!sha) throw new Error("intent sha missing");
    expect(commitWrittenBack(v1.files, 0, sha)).toBe(false);
    expect(refusal(accept(v1.repo, v1.view, 1, PO_CTX()))).toBe("gate.linked.sha-not-written");
    expect(v1.view.recordBlock).toBe(`Accept is blocked until jira JIRA-1 carries commit ${sha.slice(0, 7)} — write-back pending`);
    const failed = plan(recordWriteback(v1.repo, v1.view, { artifact: 0, kind: "committed", sha, ok: false, error: "connector down" }, ctxFor("sdlc-bot")));
    const v2 = viewOf(applyWritePlan(t1, failed), "CHG-0001");
    expect(v2.view.recordBlock).toBe(`Accept is blocked until jira JIRA-1 carries commit ${sha.slice(0, 7)} — write-back failed · retry (connector down)`);
    const r = accept(v2.repo, v2.view, 1, PO_CTX());
    expect(refusal(r)).toBe("gate.linked.sha-not-written");
    if (!r.ok) expect(r.diagnostics[0]?.message).toContain("write-back failed: connector down — retry it");

    // written back: the gate opens to the human
    const ok = plan(recordWriteback(v2.repo, v2.view, { artifact: 0, kind: "committed", sha, ok: true }, ctxFor("sdlc-bot")));
    const t3 = applyWritePlan(applyWritePlan(t1, failed), ok);
    const v3 = viewOf(t3, "CHG-0001");
    expect(commitWrittenBack(v3.files, 0, sha)).toBe(true);
    expect(v3.view.recordBlock).toBeNull();
    const accepted = plan(accept(v3.repo, v3.view, 1, PO_CTX()));
    const v4 = viewOf(applyWritePlan(t3, accepted), "CHG-0001");
    expect(v4.view.stage).toBe(2);
    expect(requiredWritebacks(v4.repo, v4.files).map((w) => [w.kind, w.sha === sha, w.state])).toEqual([["committed", true, "ok"], ["accepted", true, "pending"]]);
  });
});

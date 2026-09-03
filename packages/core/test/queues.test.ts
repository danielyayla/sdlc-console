import { beforeEach, describe, expect, it } from "vitest";
import { awaitingArtifact, badges, deriveAll, gateQueues, loadRepo, pipeline } from "../src/index.js";
import { AGENT, SHA, acceptedThrough, baseTree, ev, resetSeq, withChange } from "./helpers.js";
import { withFiles } from "../src/index.js";

beforeEach(resetSeq);

function scenario() {
  let t = baseTree();
  t = withChange(t, { id: "CHG-0001", intent: true }); // gate 1 (po), since = created
  t = withChange(t, { id: "CHG-0002", intent: true, events: [ev("artifact.committed", AGENT, { artifact: 0, path: "intent.md", sha: SHA })] }); // gate 1 (po), later since
  t = withChange(t, { id: "CHG-0003", intent: true, spec: true, plan: true, events: [...acceptedThrough([1, 2]), ev("artifact.committed", AGENT, { artifact: 2, path: "plan.md", sha: SHA }), ev("plan.final", AGENT, { rev: 1 })] }); // gate 3 (eng)
  t = withChange(t, { id: "CHG-0004" }); // agent drafting intent
  t = withChange(t, { id: "CHG-0005", intent: true, spec: true, events: acceptedThrough([2]) }); // invalid
  t = withFiles(t, {
    "sdlc/loop/triage/TRI-0001.md": "---\nschema: 1\nid: TRI-0001\ntier: incident\nsrc: s\ntitle: t\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: open\n---\nbody\n",
    "sdlc/loop/triage/TRI-0002.md": "---\nschema: 1\nid: TRI-0002\ntier: incident\nsrc: s\ntitle: t\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: dismissed\ndismissal: { by: po, reason: noise }\n---\nbody\n",
    "sdlc/security/findings/SEC-0001.yaml": "schema: 1\nid: SEC-0001\nscannerId: s\nsev: high\nconf: 0.9\nrepo: r\ntitle: t\ndesc: d\nstatus: new\n",
    "sdlc/security/findings/SEC-0002.yaml": "schema: 1\nid: SEC-0002\nscannerId: s\nsev: low\nconf: 0.5\nrepo: r\ntitle: t\ndesc: d\nstatus: dismissed\ndismissal: { by: eng, reason: fp }\n",
  });
  const repo = loadRepo(t);
  return { repo, snap: deriveAll(repo) };
}

describe("gate queues (acceptance e)", () => {
  it("splits by ownership of the active role, newest since first, invalid changes excluded", () => {
    const { snap } = scenario();
    const po = gateQueues(snap.changes, "po");
    expect(po.yours.map((c) => c.id)).toEqual(["CHG-0002", "CHG-0001"]);
    expect(po.other.map((c) => c.id)).toEqual(["CHG-0003"]);
    const eng = gateQueues(snap.changes, "eng");
    expect(eng.yours.map((c) => c.id)).toEqual(["CHG-0003"]);
    expect(eng.other.map((c) => c.id)).toEqual(["CHG-0002", "CHG-0001"]);
    expect(snap.changes.find((c) => c.id === "CHG-0005")?.valid).toBe(false);
  });
});

describe("badges", () => {
  it("counts own gates, open triage and new findings", () => {
    const { repo, snap } = scenario();
    expect(badges(snap.changes, repo, "po")).toEqual({ gates: 2, loop: 1, security: 1 });
    expect(badges(snap.changes, repo, "eng")).toEqual({ gates: 1, loop: 1, security: 1 });
  });
});

describe("pipeline and work discovery", () => {
  it("places changes in six columns and lists agent-awaited work", () => {
    const { snap } = scenario();
    const cols = pipeline(snap.changes);
    expect(cols.map((c) => [c.stage, c.changes.map((x) => x.id)])).toEqual([
      [1, ["CHG-0005", "CHG-0004", "CHG-0002", "CHG-0001"]],
      [2, []],
      [3, ["CHG-0003"]],
      [4, []],
      [5, []],
      [6, []],
    ]);
    expect(awaitingArtifact(snap.changes).map((c) => c.id)).toEqual(["CHG-0004"]);
  });
});

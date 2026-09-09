import { describe, expect, it } from "vitest";
import { parseBands, type MetricSnapshot } from "@sdlc/schemas";
import { seedTree } from "@sdlc/fixtures";
import { BASELINE_MIN_SAMPLES, applyWritePlan, bandStatus, breachEvidence, loadRepo, openBreachItem, parseInterval, parseMetricOutput, raiseBandBreaches, recordDiagnosis, routesOf, runbookById, runbookListed, sampleSigma, sigmaFor, tierOf } from "../src/index.js";

const BANDS = `metrics:
  - metric: p95_latency_ms
    baseline: 310
    unit: ms
    sigma: 40
    source: "scripts/p95.sh"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep, "Bash(gh run view *)"] }
      3sigma: { action: propose, routes: [pr, "runbook:rollback"] }
  - metric: error_rate_pct
    baseline: 0.4
    unit: "%"
    source: "scripts/errors.sh"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read] }
      3sigma: { action: propose, routes: [pr] }
  - metric: queue_depth
    baseline: 12
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read] }
      3sigma: { action: propose, routes: [] }
runbooks:
  - id: rollback
    command: "echo rollback"
  - restart
`;

function snap(metric: string, ts: string, current: number | null, sigma: number | null, baseline = 310): MetricSnapshot {
  const tier = current === null || sigma === null ? null : tierOf(current, baseline, sigma);
  return { schema: 1, metric, ts, baseline, current, sigma, tier, breached: tier !== null && tier >= 2, source: { command: "scripts/x.sh", exitCode: current === null ? 1 : 0, output: current === null ? "connection refused" : `p95 ${current}\n` } };
}

describe("bands (3.4): deterministic tiers over bands.yaml + snapshots", () => {
  const bands = parseBands(BANDS, "bands.yaml").value;
  if (!bands) throw new Error("bands");
  const bandAt = (i: number) => {
    const b = bands.metrics[i];
    if (!b) throw new Error(`band ${i}`);
    return b;
  };

  it("tierOf is Western Electric rule 1 (a point beyond k·σ), capped at 3; a zero σ never breaches", () => {
    expect(tierOf(310, 310, 40)).toBe(0);
    expect(tierOf(349, 310, 40)).toBe(0);
    expect(tierOf(350, 310, 40)).toBe(1);
    expect(tierOf(230, 310, 40)).toBe(2);
    expect(tierOf(840, 310, 40)).toBe(3);
    expect(tierOf(9999, 310, 40)).toBe(3);
    expect(tierOf(9999, 310, 0)).toBe(0);
  });

  it("σ is the declared one, else the sample deviation of the retained values once three are on file", () => {
    expect(sampleSigma([1])).toBeNull();
    expect(sampleSigma([2, 4, 4, 4, 5, 5, 7, 9])?.toFixed(3)).toBe("2.138");
    expect(sigmaFor({ sigma: 40 }, [])).toBe(40);
    const history = [snap("m", "2026-09-08T10:00:00Z", 300, null), snap("m", "2026-09-08T10:15:00Z", null, null), snap("m", "2026-09-08T10:30:00Z", 320, null)];
    expect(sigmaFor({}, history)).toBeNull();
    expect(sigmaFor({}, [...history, snap("m", "2026-09-08T10:45:00Z", 310, null)])?.toFixed(2)).toBe("10.00");
    expect(BASELINE_MIN_SAMPLES).toBe(3);
  });

  it("parses the last numeric token a source printed, and the detectEvery interval", () => {
    expect(parseMetricOutput("p95 latency (ms): 842\n")).toBe(842);
    expect(parseMetricOutput("rate=0.61%")).toBe(0.61);
    expect(parseMetricOutput("2 samples, value 1.5e2")).toBe(150);
    expect(parseMetricOutput("no number here")).toBeNull();
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("15m")).toBe(900_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(parseInterval("soon")).toBeNull();
    expect(parseInterval(undefined)).toBeNull();
  });

  it("bandStatus: no source, no data, collecting baseline, source failed, within band, breached with its open item", () => {
    const rows = bandStatus(bands, {}, []);
    expect(rows.map((r) => r.status)).toEqual(["no data · detection has not run", "no data · detection has not run", "no source · add `source:` to bands.yaml"]);
    const collecting = bandStatus(bands, { error_rate_pct: [snap("error_rate_pct", "2026-09-08T10:00:00Z", 0.5, null, 0.4)] }, [])[1];
    expect(collecting?.status).toBe("collecting baseline · 1/3 samples");
    expect(collecting?.current).toBe(0.5);
    const failed = bandStatus(bands, { p95_latency_ms: [snap("p95_latency_ms", "2026-09-08T10:00:00Z", null, 40)] }, [])[0];
    expect(failed?.status).toBe("no data · since 2026-09-08T10:00:00Z (source exit 1)");
    const fine = bandStatus(bands, { p95_latency_ms: [snap("p95_latency_ms", "2026-09-08T10:00:00Z", 320, 40)] }, [])[0];
    expect(fine).toMatchObject({ current: 320, sigma: 40, tier: 0, breached: false, action: null, status: "within 1σ · 2026-09-08T10:00:00Z" });
    const breached = bandStatus(bands, { p95_latency_ms: [snap("p95_latency_ms", "2026-09-08T10:00:00Z", 320, 40), snap("p95_latency_ms", "2026-09-08T10:15:00Z", 840, 40)] }, [{ id: "TRI-0044", src: "metric:p95_latency_ms", status: "open", job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z" }])[0];
    expect(breached).toMatchObject({ current: 840, tier: 3, breached: true, action: "propose", samples: 2, triage: ["TRI-0044"], job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z", status: "3σ · propose · TRI-0044 · 2026-09-08T10:15:00Z" });
  });

  it("the runbook allowlist: an object entry has a command, a bare id is listed but cannot run; routes split pr and runbook ids", () => {
    expect(runbookById(bands, "rollback")).toEqual({ id: "rollback", command: "echo rollback" });
    expect(runbookListed(bands, "restart")).toBe(true);
    expect(runbookById(bands, "restart")).toBeNull();
    expect(runbookListed(bands, "deploy")).toBe(false);
    expect(routesOf(bandAt(0))).toEqual({ pr: true, runbooks: ["rollback"] });
    expect(routesOf(bandAt(1))).toEqual({ pr: true, runbooks: [] });
  });

  it("raiseBandBreaches: one TRI per breached metric with the evidence verbatim and the job key, sdlc-bot actor; an open item dedupes; 1σ raises nothing", () => {
    const repo = loadRepo(seedTree());
    const band = bandAt(0);
    const three = snap("p95_latency_ms", "2026-09-08T10:15:00Z", 840, 40);
    const one = snap("error_rate_pct", "2026-09-08T10:15:00Z", 0.5, 0.15, 0.4);
    // the seed's TRI-0042 already cites metric:p95_latency_ms and is open → nothing new for it
    expect(openBreachItem(repo, "p95_latency_ms")?.id).toBe("TRI-0042");
    const deduped = raiseBandBreaches(repo, [{ band, snapshot: three, job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z" }], { now: "2026-09-08T10:15:01Z" });
    expect(deduped.ok).toBe(false);
    // with that item dismissed, the breach raises TRI-0044 (max seed id 0043 + 1)
    const tree = applyWritePlan(seedTree(), { changeId: null, files: [{ path: "sdlc/loop/triage/TRI-0042.md", content: null }], events: [], commitMessage: "x", trailers: {}, actor: { type: "system", id: "sdlc-bot" } });
    const repo2 = loadRepo(tree);
    const r = raiseBandBreaches(repo2, [{ band, snapshot: three, job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z" }, { band: bandAt(1), snapshot: one, job: "band:error_rate_pct:1σ:2026-09-08T10:15:00Z" }], { now: "2026-09-08T10:15:01Z" });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.raised).toEqual([{ id: "TRI-0044", metric: "p95_latency_ms", job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z" }]);
    expect(r.plan.actor).toEqual({ type: "system", id: "sdlc-bot" });
    expect(r.plan.trailers).toEqual({ "SDLC-Actor": "system:sdlc-bot", "SDLC-Job": "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z", "SDLC-Snapshot": "p95_latency_ms@2026-09-08T10:15:00Z" });
    const after = loadRepo(applyWritePlan(tree, r.plan));
    const item = after.triage.find((t) => t.data.id === "TRI-0044");
    expect(item?.data).toMatchObject({ tier: "3σ", src: "metric:p95_latency_ms", status: "open", job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z", title: "p95_latency_ms breached 3σ: 840 ms vs baseline 310 ms" });
    expect(item?.data.evidence).toBe(breachEvidence({ band, snapshot: three }));
    expect(item?.data.evidence).toContain("--- scripts/x.sh (exit 0)\np95 840");
    expect(item?.body).toContain("## Problem");
    expect(item?.body).toContain("## Open questions");
    expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    // a diagnosis from the session lands on the item; runbook runs become RBK records with the output verbatim
    const rec = recordDiagnosis(after, { triageId: "TRI-0044", session: "sess-abc", agent: "claude-code@sdlc.local", diagnosis: { title: "Export p95 regressed after the CSV streaming change", problem: "Commit 4f2a added a per-row lookup.", proposedOutcome: "p95 under 400 ms.", affected: "Finance; export API." }, runbookRuns: [{ runbook: "rollback", command: "echo rollback", metric: "p95_latency_ms", session: "sess-abc", actor: { type: "agent", id: "claude-code@sdlc.local" }, startedAt: "2026-09-08T10:20:00Z", finishedAt: "2026-09-08T10:20:01Z", exitCode: 0, output: "rollback\n" }], proposal: { branch: "sdlc/maintain/p95_latency_ms", head: "abcdef1234567890abcdef1234567890abcdef12" }, outcome: "session done" });
    if (!rec.ok) throw new Error(JSON.stringify(rec.diagnostics));
    expect(rec.runbookIds).toEqual(["RBK-0001"]);
    expect(rec.plan.actor).toEqual({ type: "agent", id: "claude-code@sdlc.local", session: "sess-abc" });
    expect(rec.plan.trailers).toMatchObject({ "SDLC-Actor": "agent:claude-code@sdlc.local", "SDLC-Session": "sess-abc", "SDLC-Job": "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z" });
    const final = loadRepo(applyWritePlan(applyWritePlan(tree, r.plan), rec.plan));
    const done = final.triage.find((t) => t.data.id === "TRI-0044");
    expect(done?.data).toMatchObject({ title: "Export p95 regressed after the CSV streaming change", session: "sess-abc", job: "band:p95_latency_ms:3σ:2026-09-08T10:15:00Z", status: "open" });
    expect(done?.data.evidence).toContain("p95 840"); // the detection evidence stays
    expect(done?.body).toContain("Commit 4f2a added a per-row lookup.");
    expect(done?.body).toContain("- rollback (exit 0) at 2026-09-08T10:20:01Z");
    expect(done?.body).toContain("branch sdlc/maintain/p95_latency_ms at abcdef1");
    expect(final.runbookRuns).toEqual([{ schema: 1, id: "RBK-0001", runbook: "rollback", command: "echo rollback", metric: "p95_latency_ms", session: "sess-abc", actor: { type: "agent", id: "claude-code@sdlc.local" }, startedAt: "2026-09-08T10:20:00Z", finishedAt: "2026-09-08T10:20:01Z", exitCode: 0, output: "rollback\n", triage: "TRI-0044" }]);
    expect(final.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // nothing reported → nothing to commit
    const empty = recordDiagnosis(after, { triageId: "TRI-0044", session: "sess-x", agent: "a", diagnosis: null, runbookRuns: [], proposal: null, outcome: "session error" });
    expect(empty.ok).toBe(false);
  });
});

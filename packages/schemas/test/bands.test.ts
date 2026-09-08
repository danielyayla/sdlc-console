import { describe, expect, it } from "vitest";
import { jsonSchemas, parseBands, validate } from "../src/index.js";

describe("bands.yaml (0.3, 3.4): sources, σ, the detection schedule and the runbook allowlist", () => {
  it("parses a band with source and sigma, a runbook object beside a bare id, and detectEvery", () => {
    const r = parseBands(
      `detectEvery: 15m
metrics:
  - metric: p95_latency_ms
    baseline: 310
    unit: ms
    sigma: 40
    source: "scripts/p95.sh --json | jq .p95"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read] }
      3sigma: { action: propose, routes: [pr, "runbook:rollback"] }
runbooks:
  - id: rollback
    command: "kubectl rollout undo deploy/export"
    description: Previous release.
  - restart
`,
      "bands.yaml",
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.value?.detectEvery).toBe("15m");
    expect(r.value?.metrics[0]).toMatchObject({ source: "scripts/p95.sh --json | jq .p95", sigma: 40 });
    expect(r.value?.runbooks).toEqual([{ id: "rollback", command: "kubectl rollout undo deploy/export", description: "Previous release." }, "restart"]);
  });

  it("refuses a malformed detectEvery, a non-positive sigma and a runbook without a command", () => {
    expect(parseBands("detectEvery: soon\nmetrics: []\n", "bands.yaml").diagnostics.map((d) => d.rule)).not.toEqual([]);
    expect(parseBands("metrics:\n  - metric: m\n    baseline: 1\n    sigma: 0\n    tiers: { 1sigma: { action: log }, 2sigma: { action: diagnose, tools: [] }, 3sigma: { action: propose, routes: [] } }\n", "bands.yaml").value).toBeNull();
    expect(parseBands("metrics: []\nrunbooks:\n  - id: rollback\n", "bands.yaml").value).toBeNull();
  });

  it("metric-snapshot and runbook-run are registered schemas with generated JSON", () => {
    expect(jsonSchemas["metric-snapshot"]["$id"]).toBe("https://sdlc.local/schemas/metric-snapshot.schema.json");
    expect(jsonSchemas["runbook-run"]["$id"]).toBe("https://sdlc.local/schemas/runbook-run.schema.json");
    const snap = validate("metric-snapshot", { schema: 1, metric: "m", ts: "2026-09-08T10:00:00Z", baseline: 1, current: null, sigma: null, tier: null, breached: false, source: { command: "x", exitCode: 1, output: "" } }, "s");
    expect(snap.ok).toBe(true);
    const run = validate("runbook-run", { schema: 1, id: "RBK-0001", runbook: "rollback", command: "echo", session: "sess-1", actor: { type: "agent", id: "claude-code@sdlc.local" }, startedAt: "2026-09-08T10:00:00Z", finishedAt: "2026-09-08T10:00:01Z", exitCode: 0, output: "ok\n" }, "r");
    expect(run.ok).toBe(true);
    expect(validate("runbook-run", { schema: 1, id: "RUN-0001" }, "r").ok).toBe(false);
  });
});

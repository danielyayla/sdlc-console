import { describe, expect, it } from "vitest";
import { seedTree } from "@sdlc/fixtures";
import { computeMetrics, deriveAll, loadRepo } from "../src/index.js";

describe("computeMetrics over the seed (git + ledger only)", () => {
  const repo = loadRepo(seedTree());
  const views = deriveAll(repo).changes;
  const metrics = computeMetrics(repo, views, { now: "2026-09-03T12:00:00Z" });
  const find = (stage: number, name: string) => {
    const s = metrics.find((x) => x.stage === stage);
    return [...(s?.leading ?? []), ...(s?.lagging ?? [])].find((v) => v.name === name);
  };

  it("has six stage cards with leading and lagging halves", () => {
    expect(metrics.map((s) => [s.stage, s.name, s.leading.length > 0, s.lagging.length > 0])).toEqual([
      [1, "Plan", true, true],
      [2, "Design", true, true],
      [3, "Build", true, true],
      [4, "Test", true, true],
      [5, "Deploy", true, true],
      [6, "Maintain", true, true],
    ]);
  });
  it("counts ledger events inside the 30-day window", () => {
    expect(find(1, "intents committed")).toMatchObject({ value: 7, unit: "count" });
    expect(find(6, "incidents recorded")).toMatchObject({ value: 1 });
    expect(find(3, "plan-sync blocks")).toMatchObject({ value: 2 }); // CHG-0017 and CHG-0018 (2.8 seed: the repeat signal)
    expect(find(5, "deploys")).toMatchObject({ value: 1 });
  });
  it("derives latencies and rates", () => {
    expect(find(1, "time to gate 1")?.value).toBe(0.9); // 55 minutes in the seed
    expect(find(5, "PR open → merge")?.value).toBe(18.8);
    expect(find(4, "first-pass green")).toMatchObject({ value: 67, note: "2 of 3 changes" });
    expect(find(4, "eval pass rate")).toMatchObject({ value: 100 });
    expect(find(4, "change failure rate")).toMatchObject({ value: 100, note: "1 incident over 1 merge" });
    expect(find(3, "CLAUDE.md size")).toMatchObject({ unit: "words", note: "under one page" });
    expect(find(6, "open triage")).toMatchObject({ value: 2 });
  });
  it("says what source a missing metric needs instead of showing zero", () => {
    expect(find(4, "review time per PR")).toMatchObject({ value: null, note: "n/a · needs PR metadata" });
    expect(find(6, "breached bands")?.note).toBe("n/a · needs detection snapshots");
  });
  it("trends compare with the previous window and stay flat/null without data", () => {
    const withRuns = find(4, "first-pass green");
    expect(withRuns?.trend).toBeNull(); // previous window has no runs
    expect(find(1, "intent send-backs")?.trend).toBe("flat");
  });
});

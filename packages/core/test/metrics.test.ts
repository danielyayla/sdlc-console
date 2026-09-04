import { describe, expect, it } from "vitest";
import { seedTree } from "@sdlc/fixtures";
import { computeMetrics, deriveAll, factsFromRepo, loadRepo, overlayGitHubFacts, parseWindow, withFiles, type MetricValue } from "../src/index.js";

const NOW = "2026-09-03T12:00:00Z";

function table(metrics: ReturnType<typeof computeMetrics>) {
  return (stage: number, name: string): MetricValue | undefined => {
    const s = metrics.find((x) => x.stage === stage);
    return [...(s?.leading ?? []), ...(s?.lagging ?? [])].find((v) => v.name === name);
  };
}

describe("computeMetrics over the seed with the git-mirror feeds", () => {
  const repo = loadRepo(seedTree());
  const views = deriveAll(repo).changes;
  const sources = factsFromRepo(repo);
  const find = table(computeMetrics(repo, views, { now: NOW, sources }));

  it("has six stage cards with leading and lagging halves, every metric keyed and sourced", () => {
    const metrics = computeMetrics(repo, views, { now: NOW, sources });
    expect(metrics.map((s) => [s.stage, s.name, s.leading.length > 0, s.lagging.length > 0])).toEqual([
      [1, "Plan", true, true],
      [2, "Design", true, true],
      [3, "Build", true, true],
      [4, "Test", true, true],
      [5, "Deploy", true, true],
      [6, "Maintain", true, true],
    ]);
    const all = metrics.flatMap((s) => [...s.leading, ...s.lagging]);
    expect(new Set(all.map((v) => v.key)).size).toBe(all.length);
    expect(all.filter((v) => v.sources.length === 0).map((v) => v.key)).toEqual(["breached_bands"]);
  });
  it("derives the feeds from pr.yaml, runs, checks, suite runs, incident.md and triage", () => {
    expect(sources.pr?.map((p) => [p.changeId, p.provider, p.mergedAt !== null, p.firstReviewAt, p.reviewedBy, p.agentAuthored])).toEqual([
      ["CHG-0012", "local", true, "2026-08-22T16:00:00Z", "review-job", true],
      ["CHG-0017", "local", false, null, null, true],
    ]);
    expect(sources.ci?.map((c) => `${c.changeId} ${c.name} ${c.verdict} ${c.origin}`)).toEqual([
      "CHG-0012 run-1 pass run",
      "CHG-0012 evidence pass status",
      "CHG-0017 run-1 pass run",
      "CHG-0017 evidence pass status",
      "CHG-0018 run-1 fail run",
    ]);
    expect(sources.incidents?.map((f) => [f.id, f.changeId, f.origin, f.fixedAt])).toEqual([
      ["CHG-0012/incident.md", "CHG-0012", "incident.md", null],
      ["TRI-0043", null, "triage", null],
    ]);
  });
  it("counts ledger events inside the 30-day window", () => {
    expect(find(1, "intents committed")).toMatchObject({ value: 7, unit: "count", sources: ["ledger"] });
    expect(find(3, "plan-sync blocks")).toMatchObject({ value: 2 });
    expect(find(5, "deploys")).toMatchObject({ value: 1 });
    expect(find(5, "deploy failures")).toMatchObject({ value: 0 });
  });
  it("derives latencies and rates from git and the ledger", () => {
    expect(find(1, "time to gate 1")?.value).toBe(0.9); // 55 minutes in the seed
    expect(find(4, "first-pass green")).toMatchObject({ value: 67, note: "2 of 3 changes" });
    expect(find(4, "eval pass rate")).toMatchObject({ value: 100 });
    expect(find(3, "CLAUDE.md size")).toMatchObject({ unit: "words", note: "under one page" });
    expect(find(6, "open triage")).toMatchObject({ value: 2 });
  });
  it("reads the PR, CI and incident feeds (FR-70)", () => {
    expect(find(5, "PR open → merge")).toMatchObject({ value: 18.8, note: "median of 1", sources: ["pr"] });
    expect(find(4, "review time per PR")).toMatchObject({ value: 1.8, note: "median of 1 · review job" });
    expect(find(4, "first-pass CI (agent PRs)")).toMatchObject({ value: 100, note: "2 of 2 agent PRs" });
    expect(find(4, "change failure rate")).toMatchObject({ value: 100, note: "1 incident over 1 merge" });
    expect(find(4, "regressions caught in CI vs prod")).toMatchObject({ value: 33, note: "1 in CI · 2 in production" });
    expect(find(6, "incidents recorded")).toMatchObject({ value: 2, note: "1 incident.md · 1 triage" });
    expect(find(6, "incident → fix merged")).toMatchObject({ value: null, note: "2 incidents open, none fixed in window" });
    expect(find(4, "incident → active eval")).toMatchObject({ value: null, note: "no incident-sourced cases" });
  });
  it("says what source a missing metric needs instead of showing zero", () => {
    const bare = computeMetrics(repo, views, { now: NOW });
    const none = table(bare);
    expect(none(4, "review time per PR")).toMatchObject({ value: null, note: "n/a · needs PR metadata" });
    expect(none(4, "regressions caught in CI vs prod")).toMatchObject({ value: null, note: "n/a · needs CI" });
    expect(none(6, "incidents recorded")).toMatchObject({ value: null, note: "n/a · needs incident records" });
    expect(find(6, "breached bands")?.note).toBe("n/a · needs detection snapshots");
    const seed = seedTree();
    const empty = loadRepo({ ref: seed.ref, files: new Map([...seed.files].filter(([p]) => !p.startsWith("sdlc/changes/") && !p.startsWith("sdlc/loop/") && !p.startsWith("evals/runs/"))) });
    const feeds = factsFromRepo(empty);
    expect([feeds.pr, feeds.ci, feeds.incidents]).toEqual([null, null, null]);
  });
  it("trends compare with the previous window, carry the previous value and the % change", () => {
    expect(find(4, "first-pass green")?.trend).toBeNull(); // previous window has no runs
    expect(find(1, "intent send-backs")).toMatchObject({ trend: "flat", previous: 0, delta: 0 });
    expect(find(1, "intents committed")).toMatchObject({ trend: "up", previous: 0, delta: null });
    const later = table(computeMetrics(repo, views, { now: "2026-09-20T12:00:00Z", windowDays: 10, sources }));
    expect(later(1, "intents committed")).toMatchObject({ value: 0, previous: 2, trend: "down", delta: -100 });
    expect(later(3, "plan-sync blocks")?.note).toBe("10-day window");
  });
  it("incident → active eval measures the incident to the first suite run exercising the case", () => {
    const t = withFiles(seedTree(), {
      "evals/cases/INC-CHG-0012-1.json": JSON.stringify({ schema: 1, id: "INC-CHG-0012-1", prompt: "PDF renders under 5 s", checks: [{ name: "test", cmd: "pnpm test -- pdf" }], source: { type: "incident", ref: "CHG-0012" }, owner: "incident@veri.example", added: "2026-09-02T08:00:00Z", status: "active", paths: ["src/invoice/pdf.ts"] }),
      "evals/runs/RUN-0002.json": JSON.stringify({ schema: 1, id: "RUN-0002", trigger: "schedule", configRef: repo.fingerprint, results: [{ caseId: "INC-CHG-0012-1", pass: true, output: "ok" }], passRate: 1, threshold: 0.9, verdict: "pass", startedAt: "2026-09-02T13:30:00Z", finishedAt: "2026-09-02T13:35:00Z" }),
    });
    const r2 = loadRepo(t);
    const f = table(computeMetrics(r2, deriveAll(r2).changes, { now: NOW, sources: factsFromRepo(r2) }));
    expect(f(4, "incident → active eval")).toMatchObject({ value: 6, note: "median of 1" });
  });
});

describe("GitHub facts overlay the mirror", () => {
  it("a human decision beats the review job and statuses bring CI timing", () => {
    const repo = loadRepo(seedTree());
    const base = factsFromRepo(repo);
    const github = { ...base, pr: (base.pr ?? []).map((p) => (p.changeId === "CHG-0017" ? { ...p, provider: "github" as const, number: 41 } : p)) };
    const head = github.pr.find((p) => p.changeId === "CHG-0017")?.headSha ?? "";
    const merged = overlayGitHubFacts(github, [{ number: 41, headSha: head, firstReviewAt: "2026-09-02T09:10:00Z", reviews: 2, fetchedAt: NOW }], [{ headSha: head, statuses: [{ context: "ci/build", state: "failure", createdAt: "2026-09-01T16:12:00Z", updatedAt: "2026-09-01T16:20:00Z" }, { context: "sdlc/evidence", state: "success", createdAt: "2026-09-01T16:10:00Z", updatedAt: "2026-09-01T16:10:00Z" }], fetchedAt: NOW }]);
    const pr = merged.pr?.find((p) => p.changeId === "CHG-0017");
    expect(pr).toMatchObject({ firstReviewAt: "2026-09-02T09:10:00Z", reviewedBy: "human", reviews: 2 });
    expect(merged.ci?.filter((c) => c.headSha === head).map((c) => `${c.name} ${c.verdict} ${c.origin} ${c.finishedAt ?? "-"}`)).toEqual([
      "run-1 pass run 2026-09-01T16:05:00Z",
      "sdlc/evidence pass status 2026-09-01T16:10:00Z",
      "ci/build fail status 2026-09-01T16:20:00Z",
    ]);
    const repo2 = loadRepo(seedTree());
    const find = table(computeMetrics(repo2, deriveAll(repo2).changes, { now: NOW, sources: merged }));
    expect(find(4, "review time per PR")).toMatchObject({ value: 9.4, note: "median of 2 · 1 human, 1 review job" });
    expect(find(4, "regressions caught in CI vs prod")).toMatchObject({ value: 50, note: "2 in CI · 2 in production" });
  });
});

describe("parseWindow", () => {
  it("accepts Nd up to a year and defaults to 30", () => {
    expect([parseWindow(undefined), parseWindow("7d"), parseWindow("90d"), parseWindow("0d"), parseWindow("400d"), parseWindow("week")]).toEqual([30, 7, 90, null, null, null]);
  });
});

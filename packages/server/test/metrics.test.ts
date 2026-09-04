import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gitHubCodeHostFrom } from "@sdlc/adapter-github";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { computeMetrics, deriveAll, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { Engine, FactsCache, JobStore, SessionRegistry, StateStore, collectSources, refreshFacts, refreshFactsFromEnv } from "../src/index.js";
import { startFakeGitHub, type FakeGitHub } from "../../adapters/github/test/fake-github.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const NOW = () => new Date("2026-09-03T12:00:00Z");
const HEAD_0017 = "d3f5e1c4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4";
const HEAD_0012 = "b1f3c9a2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Seed in GitHub mode: CHG-0017's open PR is #1 and CHG-0012's merged PR is #2 on the fake API. */
async function githubSeed(): Promise<{ dir: string; gh: FakeGitHub; env: Record<string, string> }> {
  const base = mkdtempSync(join(tmpdir(), "sdlc-metrics-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "clone");
  mkdirSync(dir);
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("codeHost: local", "codeHost: github"));
  const asGitHub = (id: string, number: number) => {
    const p = join(dir, `sdlc/changes/${id}/pr.yaml`);
    writeFileSync(p, readFileSync(p, "utf8").replace("provider: local", `provider: github\nnumber: ${number}\nurl: https://github.example/acme/widgets/pull/${number}`));
  };
  asGitHub("CHG-0017", 1);
  asGitHub("CHG-0012", 2);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const bare = join(base, "origin.git");
  await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "origin", "main"]);
  const gh = await startFakeGitHub({ bare, owner: "acme", repo: "widgets" });
  cleanups.push(() => gh.close());
  // the review job's COMMENT review, then a human decision; CI statuses on the open head
  gh.state.reviews.push({ number: 1, body: { state: "COMMENTED", submitted_at: "2026-09-01T16:30:00Z", user: { login: "sdlc-bot" } } });
  gh.state.reviews.push({ number: 1, body: { state: "CHANGES_REQUESTED", submitted_at: "2026-09-02T09:10:00Z", user: { login: "eli" } } });
  gh.state.statuses.push({ sha: HEAD_0017, body: { context: "ci/build", state: "failure", created_at: "2026-09-01T16:12:00Z", updated_at: "2026-09-01T16:20:00Z" } });
  gh.state.statuses.push({ sha: HEAD_0017, body: { context: "sdlc/evidence", state: "success", created_at: "2026-09-01T16:10:00Z", updated_at: "2026-09-01T16:10:00Z" } });
  gh.state.reviews.push({ number: 2, body: { state: "APPROVED", submitted_at: "2026-08-23T08:30:00Z", user: { login: "eli" } } });
  const env = { GITHUB_TOKEN: gh.token, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets" };
  return { dir, gh, env };
}

describe("metrics facts from GitHub (FR-70)", () => {
  it("fetches reviews and statuses into the cache, overlays them on the mirror, and never refetches a merged head", async () => {
    const { dir, gh, env } = await githubSeed();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const cache = new FactsCache(registry.database);
    const repo = loadRepo(await readTree(dir, "HEAD"));
    const host = gitHubCodeHostFrom(env);
    if (!host) throw new Error("no host");

    const first = await refreshFacts(host, dir, repo, cache, NOW);
    expect(first).toEqual({ prs: 2, statuses: 2, cached: 0, errors: [] });
    expect(cache.pr(1, HEAD_0017)).toMatchObject({ firstReviewAt: "2026-09-02T09:10:00Z", reviews: 2, fetchedAt: "2026-09-03T12:00:00.000Z" });
    expect(cache.pr(2, HEAD_0012)).toMatchObject({ firstReviewAt: "2026-08-23T08:30:00Z", reviews: 1 });
    expect(cache.status(HEAD_0017)?.statuses.map((s) => `${s.context} ${s.state}`)).toEqual(["ci/build failure", "sdlc/evidence success"]);
    expect(cache.status(HEAD_0012)).toEqual({ headSha: HEAD_0012, statuses: [], fetchedAt: "2026-09-03T12:00:00.000Z" });

    const { sources, status } = collectSources(repo, cache);
    expect(status).toEqual({
      pr: { via: "github", fetchedAt: "2026-09-03T12:00:00.000Z", facts: 2 },
      ci: { via: "github", fetchedAt: "2026-09-03T12:00:00.000Z", facts: 6 },
      incidents: { via: "git", fetchedAt: null, facts: 2 },
    });
    expect(sources.pr?.map((p) => [p.changeId, p.number, p.reviewedBy, p.firstReviewAt])).toEqual([
      ["CHG-0012", 2, "human", "2026-08-23T08:30:00Z"],
      ["CHG-0017", 1, "human", "2026-09-02T09:10:00Z"],
    ]);
    const metrics = computeMetrics(repo, deriveAll(repo).changes, { now: NOW().toISOString(), sources });
    const test = metrics.find((s) => s.stage === 4);
    expect(test?.lagging.find((v) => v.key === "review_time")).toMatchObject({ value: 17.7, note: "median of 2 · human reviews" });
    expect(test?.lagging.find((v) => v.key === "regressions_caught")).toMatchObject({ value: 50, note: "2 in CI · 2 in production" });

    const before = gh.state.requests.length;
    const second = await refreshFacts(host, dir, repo, cache, NOW);
    expect(second).toEqual({ prs: 1, statuses: 1, cached: 1, errors: [] });
    expect(gh.state.requests.length - before).toBe(2); // only the open PR: reviews + status

    // without a token or outside GitHub mode there is nothing to fetch — the mirror stands
    expect(await refreshFactsFromEnv(dir, repo, cache, {}, NOW)).toBeNull();
    const local = loadRepo(await readTree(dir, "HEAD"));
    local.config.codeHost = "local";
    expect(await refreshFactsFromEnv(dir, local, cache, env, NOW)).toBeNull();
    expect(collectSources(local, null).status.pr).toEqual({ via: "git", fetchedAt: null, facts: 2 });
  }, 60_000);

  it("the engine refreshes the facts on demand and the snapshot reports the feeds", async () => {
    const { dir, env } = await githubSeed();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const facts = new FactsCache(registry.database);
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list(), facts: (repo) => collectSources(repo, facts) });
    const jobs = new JobStore(registry.database);
    const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, autoLaunch: false, env, facts, syncIntervalMs: 3_600_000, now: NOW });
    cleanups.push(() => engine.close());
    const snap0 = await store.refresh();
    expect(snap0.metricSources.pr).toEqual({ via: "git", fetchedAt: null, facts: 2 });
    const r = await engine.refreshMetricFacts();
    expect(r).toMatchObject({ prs: 2, statuses: 2, cached: 0 });
    const snap1 = store.current;
    expect(snap1?.metricSources.pr).toEqual({ via: "github", fetchedAt: "2026-09-03T12:00:00.000Z", facts: 2 });
    expect(snap1?.metrics.find((s) => s.stage === 4)?.lagging.find((v) => v.key === "review_time")?.note).toBe("median of 2 · human reviews");
    // a token-less engine has nothing to refresh
    const bare = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, autoLaunch: false, env: {}, facts, now: NOW });
    cleanups.push(() => bare.close());
    expect(await bare.refreshMetricFacts()).toBeNull();
  }, 60_000);
});

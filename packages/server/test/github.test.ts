import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodeHostError, git, initRepo, isAncestor, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { ActionError, Engine, JobStore, SessionRegistry, StateStore, acceptGate, codeHostFor, launchSession, type Exec } from "../src/index.js";
import { startFakeGitHub, type FakeGitHub } from "../../adapters/github/test/fake-github.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Seed repo in GitHub mode with a bare `origin` and a fake API in front of it. */
async function githubSeed(protectedBranch = true): Promise<{ dir: string; gh: FakeGitHub; env: Record<string, string> }> {
  const base = mkdtempSync(join(tmpdir(), "sdlc-github-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "clone");
  mkdirSync(dir);
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("codeHost: local", "codeHost: github"));
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const bare = join(base, "origin.git");
  await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "origin", "main"]);
  const gh = await startFakeGitHub({ bare, owner: "acme", repo: "widgets", protected: protectedBranch });
  cleanups.push(() => gh.close());
  const env = { GITHUB_TOKEN: gh.token, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets" };
  return { dir, gh, env };
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return deriveChange(repo, files);
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });

function harness(dir: string, env: Record<string, string>) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, exec: green, autoLaunch: false, env, now: () => new Date("2026-09-04T09:00:00Z") });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

async function buildAndRun(dir: string, env: Record<string, string>) {
  const h = harness(dir, env);
  await h.store.refresh();
  const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
  const wt = launched.session.worktreePath;
  mkdirSync(join(wt, "src/export"), { recursive: true });
  writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
  h.registry.patch(launched.session.id, { status: "done" });
  const job = await h.engine.runForSession({ ...launched.session, status: "done" });
  return { ...h, job, session: launched.session, worktree: wt };
}

describe("GitHub mode (2.1): green run pushes the branch, opens a real PR, gate 5 merges through the API under branch protection", () => {
  it("opens the PR with the evidence status and mirrors number/url/head into pr.yaml → stage 5", async () => {
    const { dir, gh, env } = await githubSeed();
    const { job, store } = await buildAndRun(dir, env);
    expect(job?.state).toBe("done");
    expect(job?.note).toContain("PR opened");

    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.pr).toMatchObject({ provider: "github", number: 1, url: "https://github.example/acme/widgets/pull/1", branch: "CHG-0018/export-fix", baseBranch: "main", checks: [{ name: "evidence", verdict: "pass" }] });
    const pushed = (await git(gh.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();
    expect(view.pr?.headSha).toBe(pushed);
    expect(gh.state.pulls[0]).toMatchObject({ head: "CHG-0018/export-fix", base: "main", title: expect.stringContaining("sdlc(CHG-0018)") });
    expect(gh.state.pulls[0]?.body).toContain("sdlc/changes/CHG-0018/plan.md");
    expect(gh.state.statuses).toEqual([{ sha: pushed, body: { state: "success", context: "sdlc/evidence", description: expect.stringContaining("green"), target_url: "https://github.example/acme/widgets/pull/1" } }]);
    const opened = view.activity.find((a) => a.event === "pr.opened");
    expect(opened?.text).toContain("#1");
    // the lifecycle records stay on the console's local default branch; origin main is untouched until the merge
    expect((await git(gh.bare, ["rev-parse", "refs/heads/main"])).trim()).not.toBe((await git(dir, ["rev-parse", "main"])).trim());

    // gate 5: the engineer merges through the API; the merge commit made by the host lands on local main
    const r = await acceptGate(store, "CHG-0018", 5, env);
    expect(r.toast).toContain("Maintain");
    const after = await viewOf(dir, "CHG-0018");
    expect(after.stage).toBe(6);
    const originMain = (await git(gh.bare, ["rev-parse", "refs/heads/main"])).trim();
    expect(after.pr?.mergeSha).toBe(originMain);
    expect(gh.state.pulls[0]).toMatchObject({ merged: true, state: "closed", merge_commit_sha: originMain });
    expect(await isAncestor(dir, originMain, "main")).toBe(true);
    expect(await isAncestor(dir, pushed, "main")).toBe(true);
    const merged = after.activity.find((a) => a.event === "pr.merged");
    expect(merged?.actor).toBe("human");
    // acceptGate is idempotent from the host's point of view: a second merge is refused by GitHub, not retried around it
    const again = await acceptGate(store, "CHG-0018", 5, env).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ActionError);
  }, 30_000);

  it("refuses to push or open a PR when the base branch is unprotected", async () => {
    const { dir, gh, env } = await githubSeed(false);
    const { job } = await buildAndRun(dir, env);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("not protected");
    expect(gh.state.pulls).toHaveLength(0);
    expect((await git(gh.bare, ["branch", "--list", "CHG-0018/export-fix"])).trim()).toBe("");
    // the green run is recorded (stage derives to 5) but no PR exists: gate 5 cannot open
    const view = await viewOf(dir, "CHG-0018");
    expect(view.latestRun?.verdict).toBe("green");
    expect(view.pr).toBeNull();
    expect(view.gate).toBeNull();
  }, 30_000);

  it("merge is refused with a retryable error when the PR head moved after the tested run", async () => {
    const { dir, gh, env } = await githubSeed();
    const { store, worktree } = await buildAndRun(dir, env);
    writeFileSync(join(worktree, "src/export/late.ts"), "export const late = 1;\n");
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["commit", "-q", "-m", "late push"]);
    await git(worktree, ["push", "-q", "origin", "HEAD:CHG-0018/export-fix"]);
    const err = await acceptGate(store, "CHG-0018", 5, env).catch((e: unknown) => e as ActionError);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(502);
    expect((err as ActionError).retryable).toBe(true);
    expect((err as ActionError).message).toContain("Head branch was modified");
    expect(gh.state.pulls[0]?.merged).toBe(false);
    expect((await viewOf(dir, "CHG-0018")).stage).toBe(5);
  }, 30_000);

  it("GitHub mode without a token refuses instead of falling back to a local merge", () => {
    const err = (() => {
      try {
        codeHostFor("github", {});
        return null;
      } catch (e) {
        return e as CodeHostError;
      }
    })();
    expect(err).toBeInstanceOf(CodeHostError);
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain("GITHUB_TOKEN");
    expect(codeHostFor("local", {}).provider).toBe("local");
  });
});

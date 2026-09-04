import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodeHostError, git, initRepo, isAncestor, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, realizeSeedRepro, writeSeed } from "@sdlc/fixtures";
import { appendFinding } from "@sdlc/mcp";
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
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, exec: green, autoLaunch: false, env, syncIntervalMs: 3_600_000, now: () => new Date("2026-09-04T09:00:00Z") });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

async function buildAndRun(dir: string, env: Record<string, string>) {
  const h = harness(dir, env);
  await h.store.refresh();
  // the engine's first poll runs on that refresh; drain it here so it cannot race the commits below (main ahead → records PR)
  await h.engine.sync();
  const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
  const wt = launched.session.worktreePath;
  // 2.7: a fix merges only with a real repro commit before the fix
  const reproSha = await realizeSeedRepro(dir, wt);
  mkdirSync(join(wt, "src/export"), { recursive: true });
  writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
  h.registry.patch(launched.session.id, { status: "done" });
  const job = await h.engine.runForSession({ ...launched.session, status: "done" });
  return { ...h, job, session: launched.session, worktree: wt, reproSha };
}

describe("GitHub mode (2.1): green run pushes the branch, opens a real PR, gate 5 merges through the API under branch protection", () => {
  it("opens the PR with the evidence status and mirrors number/url/head into pr.yaml → stage 5", async () => {
    const { dir, gh, env } = await githubSeed();
    const { job, store } = await buildAndRun(dir, env);
    expect(job?.state).toBe("done");
    expect(job?.note).toContain("PR opened");

    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.pr).toMatchObject({ provider: "github", number: 1, url: "https://github.example/acme/widgets/pull/1", branch: "CHG-0018/export-fix", baseBranch: "main", checks: [expect.objectContaining({ name: "evidence", verdict: "pass" }), expect.objectContaining({ name: "evals", verdict: "pass" }), expect.objectContaining({ name: "repro", verdict: "pass" })] });
    const pushed = (await git(gh.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();
    expect(view.pr?.headSha).toBe(pushed);
    expect(gh.state.pulls[0]).toMatchObject({ head: "CHG-0018/export-fix", base: "main", title: expect.stringContaining("sdlc(CHG-0018)") });
    expect(gh.state.pulls[0]?.body).toContain("sdlc/changes/CHG-0018/plan.md");
    expect(gh.state.statuses).toEqual([
      { sha: pushed, body: { state: "success", context: "sdlc/evidence", description: expect.stringContaining("green"), target_url: "https://github.example/acme/widgets/pull/1" } },
      { sha: pushed, body: { state: "success", context: "sdlc/evals", description: expect.stringContaining("eval cases"), target_url: "https://github.example/acme/widgets/pull/1" } },
      // 2.7: the fix's repro proof travels as a status too
      { sha: pushed, body: { state: "success", context: "sdlc/repro", description: expect.stringContaining("unchanged in diff"), target_url: "https://github.example/acme/widgets/pull/1" } },
    ]);
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

// ---------------------------------------------------------------------------
// 2.2 — artifact PRs as gates
// ---------------------------------------------------------------------------
import { parseFrontMatter, stringifyFrontMatter, stringifyJsonl } from "@sdlc/schemas";
import { addWorktree, commitWritePlan, newUlid } from "@sdlc/adapter-git";
import { sendBackGate } from "../src/index.js";

const PO_ID = { id: PO, name: "Priya Owens" };
const AGENT = { id: "claude-code@sdlc.local", name: "claude-code" };

/** Draft spec.md for CHG-0022 on sdlc/CHG-0022/spec, chained to the accepted intent, the way propose_artifact would. */
async function draftSpec(dir: string, intentSha: string, concernsNote = "") {
  const branch = "sdlc/CHG-0022/spec";
  const wt = join(dir, ".sdlc-state", "worktrees", "sdlc-CHG-0022-spec");
  if (!existsSync(wt)) await addWorktree(dir, wt, branch, "main");
  const src = parseFrontMatter(readFileSync(join(dir, "sdlc/changes/CHG-0021/spec.md"), "utf8"), "spec.md");
  if (!src.ok || !src.value) throw new Error("seed spec unreadable");
  const text = stringifyFrontMatter({ ...src.value.data, id: "CHG-0022", intent_sha: intentSha, created: "2026-09-03T10:00:00Z" }, `${src.value.body}${concernsNote}`);
  const events = (await git(dir, ["show", `${branch}:sdlc/changes/CHG-0022/log.jsonl`])).trim().split("\n");
  const seq = events.length + 1;
  const event = { schema: 1, id: newUlid(), ts: "2026-09-03T10:00:00Z", seq, cycle: 1, actor: { type: "agent", id: AGENT.id, session: "s-test" }, event: "artifact.committed", data: { artifact: 1, path: "sdlc/changes/CHG-0022/spec.md", sha: "c".repeat(40) } };
  const plan = { changeId: "CHG-0022", files: [{ path: "sdlc/changes/CHG-0022/spec.md", content: text }], events: [{ changeId: "CHG-0022", event: event as never }], commitMessage: "sdlc(CHG-0022): propose spec.md", trailers: { "SDLC-Actor": `agent:${AGENT.id}` }, actor: { type: "agent" as const, id: AGENT.id, session: "s-test" } };
  await commitWritePlan(wt, plan, { identity: AGENT });
  void stringifyJsonl;
  return { branch, wt };
}

async function mergeOnGitHub(gh: FakeGitHub, number: number, login: string): Promise<{ sha: string }> {
  const res = await fetch(`${gh.url}/repos/${gh.owner}/${gh.repo}/pulls/${number}/merge`, { method: "PUT", headers: { Authorization: `Bearer ${gh.token}`, "Content-Type": "application/json", "x-fake-login": login }, body: JSON.stringify({ merge_method: "merge" }) });
  if (!res.ok) throw new Error(`fake merge ${res.status}: ${await res.text()}`);
  return (await res.json()) as { sha: string };
}

function mapLogin(dir: string, id: string, login: string): void {
  const cfg = join(dir, "sdlc/config.yaml");
  const text = readFileSync(cfg, "utf8");
  const marker = `  - id: ${id}\n`;
  if (!text.includes(marker)) throw new Error(`identity ${id} not in config`);
  writeFileSync(cfg, text.replace(marker, `${marker}    github: ${login}\n`));
}

describe("artifact PRs as gates in GitHub mode (2.2)", () => {
  it("spec drafted on its branch → engine opens the PR → in review with link → send back posts a review → accept merges the PR → stage 3; records PR carries the console's commits", async () => {
    const { dir, gh, env } = await githubSeed();
    mapLogin(dir, PO, "priya-gh");
    await git(dir, ["commit", "-q", "-am", "sdlc(config): map priya-gh"]);
    await git(dir, ["push", "-q", "origin", "main"]);
    const { engine, store } = harness(dir, env);
    const po = new StateStore({ root: dir, identity: PO_ID });

    // gate 1: the intent sits on main (no branch, no PR) → accepted in the console, recorded locally
    const g1 = await acceptGate(po, "CHG-0022", 1, env);
    expect(g1.toast).toContain("Design");
    const intentSha = (await viewOf(dir, "CHG-0022")).docs[0].sha ?? "";
    expect(intentSha).toHaveLength(40);

    // the agent drafts spec.md on sdlc/CHG-0022/spec
    const { branch } = await draftSpec(dir, intentSha);
    let sync = await engine.sync();
    expect(sync?.opened).toEqual([{ changeId: "CHG-0022", artifact: 1, branch, number: 1, url: "https://github.example/acme/widgets/pull/1" }]);
    // the console's local gate-1 decision reaches origin through the records PR, opened on the same pass
    expect(sync?.records).toMatchObject({ ahead: 1, pushed: true, number: 2 });
    expect(gh.state.pulls[1]).toMatchObject({ head: "sdlc/records", base: "main", title: "sdlc: lifecycle records" });
    expect(await git(gh.bare, ["show", "refs/heads/sdlc/records:sdlc/changes/CHG-0022/log.jsonl"])).toContain('"gate":1');
    expect(gh.state.pulls[0]).toMatchObject({ head: branch, base: "main", title: expect.stringContaining("spec.md for review") });
    // recorded on the branch and pushed: origin's branch carries pr.opened{artifact: 1}
    expect(await git(gh.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/log.jsonl`])).toContain('"artifact":1,"branch":"sdlc/CHG-0022/spec"');
    // main does not have the spec, yet the console shows it in review
    expect((await gitRawShow(dir, "main:sdlc/changes/CHG-0022/spec.md"))).toBeNull();
    let snap = await po.refresh(true);
    let v = snap.changes.find((c) => c.id === "CHG-0022");
    expect(v?.stage).toBe(2);
    expect(v?.docs[1].state).toBe("pending-review");
    expect(v?.gate?.s).toBe(2);
    expect(v?.artifactPrs[1]).toMatchObject({ number: 1, branch, merged: false });
    expect(v?.activity[0]?.text).toContain("spec.md in review as PR #1");
    // a second pass opens nothing new
    sync = await engine.sync();
    expect(sync?.opened).toEqual([]);

    // send back: the event lands on the branch and GitHub gets a request-changes review
    const sb = await sendBackGate(po, "CHG-0022", 2, "resolve concern C1 before review", env);
    expect(sb.toast).toContain("sent back on PR #1");
    expect(gh.state.reviews).toEqual([{ number: 1, body: { event: "REQUEST_CHANGES", body: "resolve concern C1 before review" } }]);
    expect(await git(gh.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/log.jsonl`])).toContain('"gate.sent_back"');
    snap = await po.refresh(true);
    v = snap.changes.find((c) => c.id === "CHG-0022");
    expect(v?.gate).toBeNull();
    expect(v?.agent).toBe(true);
    // the agent revises on the same branch; the gate reopens on the same PR, and the revision is pushed so the PR the reviewer reads is current
    expect(await git(gh.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/spec.md`])).not.toContain("C1 resolved");
    await draftSpec(dir, intentSha, "\nC1 resolved with marketing.\n");
    sync = await engine.sync();
    expect(sync?.opened).toEqual([]);
    expect(sync?.pushed).toEqual([{ changeId: "CHG-0022", artifact: 1, branch, number: 1, head: (await git(dir, ["rev-parse", branch])).trim() }]);
    expect(await git(gh.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/spec.md`])).toContain("C1 resolved");
    // nothing moved: the next pass pushes nothing
    sync = await engine.sync();
    expect(sync?.pushed).toEqual([]);
    snap = await po.refresh(true);
    v = snap.changes.find((c) => c.id === "CHG-0022");
    expect(v?.gate?.s).toBe(2);

    // accept: decision committed on the branch, PR merged through the API, spec + decision now on main
    const g2 = await acceptGate(po, "CHG-0022", 2, env);
    expect(g2.toast).toContain("PR #1 merged");
    expect(gh.state.pulls[0]).toMatchObject({ merged: true, merged_by: "token-user" });
    const originLog = await git(gh.bare, ["show", "refs/heads/main:sdlc/changes/CHG-0022/log.jsonl"]);
    expect(originLog).toContain('"gate":2');
    expect(originLog).toContain('"source":"pr.merge"');
    expect(await git(gh.bare, ["show", "refs/heads/main:sdlc/changes/CHG-0022/spec.md"])).toContain("C1 resolved");
    v = (await viewOf(dir, "CHG-0022"));
    expect(v.stage).toBe(3);
    expect(v.docs[1].state).toBe("committed");
    expect(v.artifactPrs[1]?.merged).toBe(true);
    expect(v.acceptedGates).toEqual([1, 2]);
    expect((await po.refresh(true)).branches).toEqual([]);

    // the spec branch was cut from local main, so PR #1 also carried the gate-1 commit: nothing is left to push
    sync = await engine.sync();
    expect(sync?.records).toEqual({ ahead: 0, pushed: false });
    // a console-only decision (send-back on an artifact that sits on main) stays local until the records PR merges
    await sendBackGate(po, "CHG-0021", 2, "needs the pricing table", env);
    sync = await engine.sync();
    expect(sync?.records).toMatchObject({ ahead: 1, pushed: true, number: 2 });
    expect(await git(gh.bare, ["show", "refs/heads/sdlc/records:sdlc/changes/CHG-0021/log.jsonl"])).toContain('"gate.sent_back"');
    expect(await gitRawShow(gh.bare, "refs/heads/main:sdlc/changes/CHG-0021/log.jsonl")).not.toContain('"gate.sent_back"');
    // a human merges the records PR; the next pass takes origin's main and has nothing left to push
    await mergeOnGitHub(gh, 2, "priya-gh");
    sync = await engine.sync();
    expect(sync?.records).toEqual({ ahead: 0, pushed: false });
    expect((await git(dir, ["rev-list", "--count", "origin/main..main"])).trim()).toBe("0");
    expect(await git(gh.bare, ["show", "refs/heads/main:sdlc/changes/CHG-0021/log.jsonl"])).toContain('"gate.sent_back"');
    expect((await viewOf(dir, "CHG-0022")).stage).toBe(3);
    void store;
  }, 60_000);

  it("a branch carrying ledger lines only (a session started or failed before proposing) opens no PR; the PR opens once the artifact is on it", async () => {
    const { dir, gh, env } = await githubSeed();
    const { engine } = harness(dir, env);
    const po = new StateStore({ root: dir, identity: PO_ID });
    await acceptGate(po, "CHG-0022", 1, env);
    const intentSha = (await viewOf(dir, "CHG-0022")).docs[0].sha ?? "";
    // the session's start is recorded on the artifact branch before any spec.md exists
    const branch = "sdlc/CHG-0022/spec";
    const wt = join(dir, ".sdlc-state", "worktrees", "sdlc-CHG-0022-spec");
    await addWorktree(dir, wt, branch, "main");
    const event = { schema: 1, id: newUlid(), ts: "2026-09-03T09:59:00Z", seq: 3, cycle: 1, actor: { type: "system", id: "sdlc-bot@sdlc.local" }, event: "note", data: { text: "session s-test started (HEADLESS)" } };
    await commitWritePlan(wt, { changeId: "CHG-0022", files: [], events: [{ changeId: "CHG-0022", event: event as never }], commitMessage: "sdlc(CHG-0022): session s-test started (HEADLESS)", trailers: {}, actor: { type: "system" as const, id: "sdlc-bot@sdlc.local" } }, { identity: { id: "sdlc-bot@sdlc.local", name: "sdlc-bot" } });
    expect((await po.refresh(true)).branches.map((b) => b.branch)).toEqual([branch]);
    let sync = await engine.sync();
    expect(sync?.opened).toEqual([]);
    expect(sync?.errors).toEqual([]);
    expect(gh.state.pulls.filter((p) => p.head === branch)).toEqual([]);
    // the spec lands on the same branch → the PR opens on the next pass
    await draftSpec(dir, intentSha);
    sync = await engine.sync();
    expect(sync?.opened).toMatchObject([{ changeId: "CHG-0022", artifact: 1, branch }]);
    expect(await git(gh.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/spec.md`])).toContain("CHG-0022");
  }, 60_000);

  it("a PR merged on GitHub is recorded under the identity mapped to the merger; an unmapped merger is not guessed", async () => {
    const { dir, gh, env } = await githubSeed();
    mapLogin(dir, PO, "priya-gh");
    await git(dir, ["commit", "-q", "-am", "sdlc(config): map priya-gh"]);
    await git(dir, ["push", "-q", "origin", "main"]);
    const { engine } = harness(dir, env);
    const po = new StateStore({ root: dir, identity: PO_ID });
    await acceptGate(po, "CHG-0022", 1, env);
    const intentSha = (await viewOf(dir, "CHG-0022")).docs[0].sha ?? "";
    await draftSpec(dir, intentSha);
    await engine.sync();

    // the product owner merges on GitHub itself
    await mergeOnGitHub(gh, 1, "priya-gh");
    const sync = await engine.sync();
    expect(sync?.merges).toEqual([{ changeId: "CHG-0022", gate: 2, number: 1, mergedBy: "priya-gh", recorded: true }]);
    const v = await viewOf(dir, "CHG-0022");
    expect(v.stage).toBe(3);
    const acc = v.activity.find((a) => a.event === "gate.accepted");
    expect(acc).toMatchObject({ actor: "human", actorId: PO });
    expect((await git(dir, ["show", "-s", "--format=%an <%ae>", "HEAD"])).trim()).toBe("Priya Owens <po@veri.example>");
  }, 60_000);

  it("an unmapped merger leaves the decision unrecorded and visible, and the owner can still accept in the console", async () => {
    const { dir, gh, env } = await githubSeed();
    const { engine } = harness(dir, env);
    const po = new StateStore({ root: dir, identity: PO_ID });
    await acceptGate(po, "CHG-0022", 1, env);
    const intentSha = (await viewOf(dir, "CHG-0022")).docs[0].sha ?? "";
    await draftSpec(dir, intentSha);
    await engine.sync();
    await mergeOnGitHub(gh, 1, "stranger");
    const sync = await engine.sync();
    expect(sync?.merges[0]).toMatchObject({ gate: 2, mergedBy: "stranger", recorded: false, reason: expect.stringContaining("does not hold") });
    // origin's merge was taken: the spec is on main, gate 2 still open, and the owner accepts it in the console (source console)
    const v = await viewOf(dir, "CHG-0022");
    expect(v.docs[1].state).toBe("pending-review");
    expect(v.acceptedGates).toEqual([1]);
    const g2 = await acceptGate(po, "CHG-0022", 2, env);
    expect(g2.toast).toContain("Build");
    expect((await viewOf(dir, "CHG-0022")).stage).toBe(3);
  }, 60_000);
});

describe("review findings mirror + check runs in GitHub mode (2.3)", () => {
  it("evidence and evals statuses at open; a review session's findings become events, tally, findings status and a COMMENT review — and never block the code owner", async () => {
    const { dir, gh, env } = await githubSeed();
    const h = await buildAndRun(dir, env);
    expect(h.job?.state).toBe("done");
    const pushed = (await git(gh.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();
    expect(gh.state.statuses.map((s) => s.body["context"])).toEqual(["sdlc/evidence", "sdlc/evals", "sdlc/repro"]); // the fix carries its repro proof as a status (2.7)

    // the review session reads the PR branch worktree and commits nothing there: the PR head stays the tested head
    const review = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
    expect(review.session.worktreePath).toBe(h.worktree);
    expect(review.session.branch).toBe("CHG-0018/export-fix");
    expect((await git(h.worktree, ["rev-parse", "HEAD"])).trim()).toBe(pushed);
    const startedOnMain = (await git(dir, ["log", "-1", "--format=%s", "main"])).trim();
    expect(startedOnMain).toContain(`session ${review.session.id} started`);

    appendFinding(h.worktree, review.session.id, { n: 1, ts: "2026-09-04T09:05:00Z", severity: "high", title: "export drops rows whose amount is 0", path: "src/export/csv.ts", detail: "rows.filter(Boolean) removes { amount: 0 } — spec §2 requires zero-total rows" });
    appendFinding(h.worktree, review.session.id, { n: 2, ts: "2026-09-04T09:06:00Z", severity: "low", title: "no test for the empty export" });
    h.registry.patch(review.session.id, { status: "done" });
    const job = await h.engine.mirrorForSession({ ...review.session, status: "done" });
    expect(job?.state).toBe("done");
    expect(job?.note).toBe(`review of ${pushed.slice(0, 7)}: 1 high · 0 medium · 1 low`);

    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.pr?.findings).toEqual({ high: 1, medium: 0, low: 1 });
    expect(view.pr?.checks.map((c) => [c.name, c.verdict])).toEqual([["evidence", "pass"], ["evals", "pass"], ["repro", "pass"], ["findings", "fail"]]);
    expect(view.pr?.review).toEqual({ session: review.session.id, headSha: pushed, at: "2026-09-04T09:00:00Z" });
    expect(view.findings.map((f) => [f.severity, f.title, f.path, f.session])).toEqual([
      ["high", "export drops rows whose amount is 0", "src/export/csv.ts", review.session.id],
      ["low", "no test for the empty export", null, review.session.id],
    ]);
    const events = view.activity.filter((a) => a.event === "review.finding");
    expect(events).toHaveLength(2);
    expect(events.every((a) => a.actor === "agent")).toBe(true);
    // the commit is the system's; the PR head did not move
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>", "main"])).trim()).toBe("sdlc-bot <sdlc-bot@sdlc.local>");
    expect((await git(gh.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim()).toBe(pushed);
    // on GitHub: the tally as a failing status on the reviewed head, the findings verbatim as a COMMENT review (never an approval)
    expect(gh.state.statuses.at(-1)).toEqual({ sha: pushed, body: { state: "failure", context: "sdlc/findings", description: `review of ${pushed.slice(0, 7)}: 1 high · 0 medium · 1 low`, target_url: "https://github.example/acme/widgets/pull/1" } });
    expect(gh.state.reviews).toHaveLength(1);
    expect(gh.state.reviews[0]?.body["event"]).toBe("COMMENT");
    const body = String(gh.state.reviews[0]?.body["body"]);
    expect(body).toContain("- **high** export drops rows whose amount is 0 — `src/export/csv.ts`");
    expect(body).toContain("rows.filter(Boolean) removes { amount: 0 }");
    expect(body).toContain("- **low** no test for the empty export");
    expect(gh.state.reviews.some((r) => r.body["event"] === "APPROVE")).toBe(false);

    // mirroring the same session again is a no-op job; a second review of the same head is refused by the record
    expect(await h.engine.mirrorForSession({ ...review.session, status: "done" })).toBeNull();
    const again = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
    h.registry.patch(again.session.id, { status: "done" });
    const dup = await h.engine.mirrorForSession({ ...again.session, status: "done" });
    expect(dup?.state).toBe("failed");
    expect(dup?.error).toContain("already reviewed");

    // findings inform: the code owner still merges through the API
    const r = await acceptGate(h.store, "CHG-0018", 5, env);
    expect(r.toast).toContain("Maintain");
    expect((await viewOf(dir, "CHG-0018")).stage).toBe(6);
  }, 40_000);
});

async function gitRawShow(dir: string, spec: string): Promise<string | null> {
  try {
    return await git(dir, ["show", spec]);
  } catch {
    return null;
  }
}

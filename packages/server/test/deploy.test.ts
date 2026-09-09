import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitTrailers, git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo, validateTree } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { appendSessionDeploy } from "@sdlc/mcp";
import { ActionError, Engine, JobStore, SessionRegistry, StateStore, acceptGate, deployEnvironment, publishRollbackCheck, rehearseRollback, type DeployExec, type StoredSession } from "../src/index.js";
import { startFakeGitHub, type FakeApp, type FakeGitHub } from "../../adapters/github/test/fake-github.js";

const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const PRIYA = { id: PO, name: "Priya Owens" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const APP: FakeApp = { id: 4242, slug: "sdlc-console", installationId: 77, publicKey: pair.publicKey };

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-deploy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", PRIYA);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

/** The seed with CHG-0017 merged at gate 5 (local mode): the production gate is open, nothing deployed. */
async function merged(): Promise<{ dir: string; store: StateStore; mergeSha: string }> {
  const dir = await seeded();
  // the task branch the seed's pr.yaml names, with one commit, so the local merge has something to merge
  await git(dir, ["checkout", "-q", "-b", "CHG-0017/export"]);
  mkdirSync(join(dir, "src/export"), { recursive: true });
  writeFileSync(join(dir, "src/export/csv.ts"), "export const csv = 1;\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(CHG-0017): csv export"]);
  await git(dir, ["checkout", "-q", "main"]);
  const store = new StateStore({ root: dir, identity: ENG });
  await acceptGate(store, "CHG-0017", 5);
  const view = await viewOf(dir, "CHG-0017");
  if (!view.pr?.mergeSha) throw new Error("not merged");
  return { dir, store, mergeSha: view.pr.mergeSha };
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return deriveChange(repo, files);
}

interface Call {
  cmd: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

/** A fake shell: records every call with its variables; preview deploys fail, everything else prints what it was asked. */
function fakeExec(calls: Call[]): DeployExec {
  return (cmd, cwd, env) => {
    calls.push({ cmd, cwd, env });
    if (env["SDLC_ENV"] === "preview" && cmd.startsWith("echo deploy")) return Promise.resolve({ exitCode: 1, output: "preview stack missing\nerror: no such stack\n" });
    return Promise.resolve({ exitCode: 0, output: `${cmd.replace("$SDLC_SHA", env["SDLC_SHA"] ?? "")}\n` });
  };
}

describe("deployment through the console (3.6, local mode): environments, the rehearsal and the production gate", () => {
  it("golden path: production refuses until staging is deployed and its rollback rehearsed; then the gate's owner deploys production — the decision is committed before the command runs, the outcome after, both under the person", async () => {
    const { dir, store, mergeSha } = await merged();
    const calls: Call[] = [];
    const exec = fakeExec(calls);
    const open = await viewOf(dir, "CHG-0017");
    expect(open.stage).toBe(6);
    expect(open.status).toBe("Merged · production gate needs a rollback rehearsal");
    expect(open.deploy.productionGate).toMatchObject({ open: true, sha: mergeSha, ownerRoles: ["eng"] });

    // 1. production before the rehearsal: refused, and no command ran
    const refused = await deployEnvironment(store, "CHG-0017", "production", { exec }).catch((e: unknown) => e as ActionError);
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).status).toBe(409);
    expect((refused as ActionError).diagnostics[0]?.rule).toBe("production.rollback-not-rehearsed");
    expect(calls).toEqual([]);
    const headBefore = (await git(dir, ["rev-parse", "HEAD"])).trim();

    // 2. staging deploys at the merged commit: the declared command, with the deploy variables, the healthcheck after it
    const staging = await deployEnvironment(store, "CHG-0017", "staging", { exec });
    expect(staging.toast).toBe(`CHG-0017 deployed to staging · ${mergeSha.slice(0, 7)}`);
    expect(calls.map((c) => [c.cmd, c.env["SDLC_ENV"], c.env["SDLC_ENV_KIND"], c.env["SDLC_SHA"], c.env["SDLC_CHANGE"], c.cwd])).toEqual([
      ["echo deploy staging $SDLC_SHA", "staging", "staging", mergeSha, "CHG-0017", dir],
      ["echo staging healthy", "staging", "staging", mergeSha, "CHG-0017", dir],
    ]);
    expect(staging.deployment).toMatchObject({ env: "staging", status: "succeeded", sha: mergeSha, command: "echo deploy staging $SDLC_SHA", exitCode: 0, output: `echo deploy staging ${mergeSha}\n`, actor: { type: "human", id: ENG.id }, healthcheck: { exitCode: 0, output: "echo staging healthy\n" } });
    // two commits by the engineer: started (running) then finished
    const log = (await git(dir, ["log", `${headBefore}..HEAD`, "--format=%an <%ae> %s"])).trim().split("\n");
    expect(log).toEqual([`Eli Ng <${ENG.id}> sdlc(CHG-0017): deploy staging ← ${mergeSha.slice(0, 7)} succeeded`, `Eli Ng <${ENG.id}> sdlc(CHG-0017): deploy staging ← ${mergeSha.slice(0, 7)}`]);

    // 3. preview fails: the failure is on record with its output, and the gate is unmoved
    const preview = await deployEnvironment(store, "CHG-0017", "preview", { exec });
    expect(preview.toast).toBe("CHG-0017: deploy to preview failed (exit 1) — output recorded");
    expect(preview.deployment).toMatchObject({ status: "failed", exitCode: 1, output: "preview stack missing\nerror: no such stack\n" });
    const afterPreview = await viewOf(dir, "CHG-0017");
    expect(afterPreview.deploy.environments.map((e) => [e.name, e.status])).toEqual([["preview", "failed"], ["staging", "succeeded"], ["production", "not-deployed"]]);
    expect(afterPreview.activity[0]?.text).toBe("deploy to preview failed: echo deploy preview $SDLC_SHA exited 1");
    expect(afterPreview.deploy.productionGate?.blocked).toContain("no rollback rehearsal recorded");

    // 4. the rehearsal: refused against production and against preview (nothing deployed there); recorded on staging at the merged commit
    await expect(rehearseRollback(store, "CHG-0017", "production", { exec })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("never production") });
    await expect(rehearseRollback(store, "CHG-0017", "preview", { exec })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("nothing is deployed to preview") });
    const rehearsal = await rehearseRollback(store, "CHG-0017", "staging", { exec });
    expect(rehearsal.toast).toContain("rollback rehearsed on staging");
    expect(rehearsal.rehearsal).toMatchObject({ env: "staging", sha: mergeSha, status: "succeeded", command: "echo rollback staging to previous release", exitCode: 0, output: "echo rollback staging to previous release\n", actor: { type: "human", id: ENG.id } });
    expect(rehearsal.published).toEqual([]);
    const ready = await viewOf(dir, "CHG-0017");
    expect(ready.status).toBe("Merged · production gate — waiting on the engineer");
    expect(ready.deploy.productionGate?.checks[0]).toMatchObject({ name: "sdlc/rollback-rehearsed", verdict: "pass", evidence: "echo rollback staging to previous release\n" });

    // 5. the gate: the product owner does not hold it; the engineer does, and the command runs only after the decision is committed
    const notOwner = await deployEnvironment(store.as(PRIYA), "CHG-0017", "production", { exec }).catch((e: unknown) => e as ActionError);
    expect(notOwner).toBeInstanceOf(ActionError);
    expect((notOwner as ActionError).status).toBe(403);
    expect((notOwner as ActionError).diagnostics[0]?.rule).toBe("production.not-owner");
    const beforeProd = calls.length;
    const headBeforeProd = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const production = await deployEnvironment(store, "CHG-0017", "production", { exec });
    expect(production.toast).toBe(`CHG-0017 deployed to production · ${mergeSha.slice(0, 7)} · production gate accepted`);
    expect(calls.slice(beforeProd).map((c) => [c.cmd, c.env["SDLC_ENV_KIND"]])).toEqual([["echo deploy production $SDLC_SHA", "production"], ["echo production healthy", "production"]]);
    const prodLog = (await git(dir, ["log", `${headBeforeProd}..HEAD`, "--format=%ae %s"])).trim().split("\n");
    expect(prodLog).toEqual([`${ENG.id} sdlc(CHG-0017): deploy production ← ${mergeSha.slice(0, 7)} succeeded`, `${ENG.id} sdlc(CHG-0017): production gate accepted → deploy production ← ${mergeSha.slice(0, 7)}`]);
    const decision = (await git(dir, ["rev-parse", "HEAD~1"])).trim();
    expect(await commitTrailers(dir, decision)).toMatchObject({ "SDLC-Actor": `human:${ENG.id}` });
    const done = await viewOf(dir, "CHG-0017");
    expect(done.status).toBe("Deployed · monitoring");
    expect(done.deploy.productionGate).toMatchObject({ open: false, authorized: { by: ENG.id }, deployment: expect.objectContaining({ status: "succeeded", sha: mergeSha, authorizedBy: ENG.id, output: `echo deploy production ${mergeSha}\n` }) });
    expect(done.activity.map((a) => a.event).slice(0, 4)).toEqual(["deploy.finished", "deploy.started", "deploy.authorized", "rollback.rehearsed"]);
    expect(done.activity[2]?.text).toBe(`accepted the production gate: authorized ${mergeSha.slice(0, 7)} to production`);
    const record = readFileSync(join(dir, "sdlc/changes/CHG-0017/deploy.yaml"), "utf8");
    expect(record).toContain("env: production");
    expect(record).toContain(`authorizedBy: ${ENG.id}`);
    expect(record).toContain("rehearsals:");
    expect(validateTree(loadRepo(await readTree(dir, "HEAD"))).blocking).toBe(false);

    // 6. the gate is closed: a second production deploy is refused
    const again = await deployEnvironment(store, "CHG-0017", "production", { exec }).catch((e: unknown) => e as ActionError);
    expect((again as ActionError).diagnostics[0]?.rule).toBe("production.gate-closed");
    // an unknown environment is a 404; a change without a PR has nothing to deploy
    await expect(deployEnvironment(store, "CHG-0017", "moon", { exec })).rejects.toMatchObject({ status: 404 });
    await expect(deployEnvironment(store, "CHG-0022", "staging", { exec })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no pull request yet") });
  }, 30_000);

  it("a session's deploy_<env> and rehearse_rollback outcomes are recorded by the engine when the session ends: one sdlc-bot commit with the job trailer and the agent as actor, and the gate's check turns green", async () => {
    const { dir, mergeSha } = await merged();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
    const jobs = new JobStore(registry.database);
    const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, autoLaunch: false, now: () => new Date("2026-09-08T10:00:00Z") });
    cleanups.push(() => engine.close());
    await store.refresh();
    const session = { id: "sess-dep01", changeId: "CHG-0017", cycle: 1, kind: "build", status: "stopped", worktreePath: dir, branch: "CHG-0017/export", startedAt: "2026-09-08T09:00:00Z", heartbeatAt: "2026-09-08T09:30:00Z", mode: "HEADLESS", taskId: null, engineer: null, target: null, error: null, costUsd: null, resumeCount: 0 } as unknown as StoredSession;
    appendSessionDeploy(dir, session.id, { kind: "deploy", env: "staging", sha: mergeSha, startedAt: "2026-09-08T09:10:00Z", finishedAt: "2026-09-08T09:12:00Z", exitCode: 0, output: `deploy staging ${mergeSha}\n`, healthcheck: { command: "echo staging healthy", exitCode: 0, output: "staging healthy\n" } });
    appendSessionDeploy(dir, session.id, { kind: "rehearsal", env: "staging", sha: mergeSha, rehearsedAt: "2026-09-08T09:15:00Z", finishedAt: "2026-09-08T09:16:00Z", exitCode: 0, output: "rollback staging to previous release\n" });
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await engine.onSessionExit(session);
    const job = jobs.list().find((j) => j.kind === "deploy-record");
    expect(job).toMatchObject({ key: "deploy-record:sess-dep01", state: "done", changeId: "CHG-0017", note: expect.stringContaining("rollback rehearsed on staging") });
    const commit = (await git(dir, ["rev-parse", "HEAD"])).trim();
    expect(commit).not.toBe(head);
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>%n%s"])).trim()).toBe(`sdlc-bot <sdlc-bot@sdlc.local>\nsdlc(CHG-0017): deploy staging ← ${mergeSha.slice(0, 7)} succeeded · rollback rehearsed on staging at ${mergeSha.slice(0, 7)} succeeded`);
    expect(await commitTrailers(dir, commit)).toMatchObject({ "SDLC-Job": "deploy-record:sess-dep01", "SDLC-Actor": "agent:claude-code@sdlc.local", "SDLC-Session": "sess-dep01" });
    const view = await viewOf(dir, "CHG-0017");
    expect(view.deploy.environments.find((e) => e.name === "staging")).toMatchObject({ status: "succeeded", latest: expect.objectContaining({ actor: { type: "agent", id: "claude-code@sdlc.local", session: "sess-dep01" }, healthcheck: expect.objectContaining({ exitCode: 0 }) }) });
    expect(view.deploy.rehearsals).toHaveLength(1);
    expect(view.deploy.productionGate?.checks[0]?.verdict).toBe("pass");
    expect(view.status).toBe("Merged · production gate — waiting on the engineer");
    expect(view.activity.slice(0, 3).map((a) => [a.event, a.actor])).toEqual([["rollback.rehearsed", "agent"], ["deploy.finished", "agent"], ["deploy.started", "agent"]]);
    // once per session: a replayed exit records nothing twice
    await engine.onSessionExit(session);
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(commit);
    expect(validateTree(loadRepo(await readTree(dir, "HEAD"))).blocking).toBe(false);
  }, 30_000);
});

/** Seed in GitHub mode with a bare `origin` and the fake API; token mode by default, App mode with `app`. */
async function githubSeed(app?: FakeApp): Promise<{ dir: string; gh: FakeGitHub; env: Record<string, string> }> {
  const base = mkdtempSync(join(tmpdir(), "sdlc-deploy-gh-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "clone");
  mkdirSync(dir);
  await initRepo(dir, "main", PRIYA);
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
  const gh = await startFakeGitHub({ bare, owner: "acme", repo: "widgets", protected: true, ...(app ? { app } : {}) });
  cleanups.push(() => gh.close());
  const env = app
    ? { SDLC_GITHUB_APP_ID: String(app.id), SDLC_GITHUB_APP_INSTALLATION_ID: String(app.installationId), SDLC_GITHUB_APP_PRIVATE_KEY: pair.privateKey, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets" }
    : { GITHUB_TOKEN: gh.token, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets" };
  return { dir, gh, env };
}

describe("sdlc/rollback-rehearsed on GitHub (3.6): a commit status under a token, a check run with the evidence under the App", () => {
  it("token mode: the rehearsal publishes a success status on the PR head; a failed rehearsal publishes failure", async () => {
    const { dir, gh, env } = await githubSeed();
    const store = new StateStore({ root: dir, identity: ENG });
    const calls: Call[] = [];
    let rollbackExit = 0;
    const exec: DeployExec = (cmd, cwd, vars) => {
      calls.push({ cmd, cwd, env: vars });
      return Promise.resolve({ exitCode: cmd.startsWith("echo rollback") ? rollbackExit : 0, output: `${cmd}\n` });
    };
    // CHG-0017's PR is open at the seed's head: staging takes the PR head before the merge
    const head = (await viewOf(dir, "CHG-0017")).pr?.headSha ?? "";
    await deployEnvironment(store, "CHG-0017", "staging", { exec, env });
    expect(calls[0]?.env["SDLC_SHA"]).toBe(head);
    const r = await rehearseRollback(store, "CHG-0017", "staging", { exec, env });
    expect(r.published).toEqual([head]);
    expect(gh.state.statuses).toEqual([{ sha: head, body: { state: "success", context: "sdlc/rollback-rehearsed", description: expect.stringContaining("rollback rehearsed on staging at " + head.slice(0, 7)) } }]);
    expect(gh.state.checkRuns).toEqual([]);
    rollbackExit = 2;
    const red = await rehearseRollback(store, "CHG-0017", "staging", { exec, env });
    expect(red.rehearsal.status).toBe("failed");
    expect(gh.state.statuses.at(-1)).toEqual({ sha: head, body: { state: "failure", context: "sdlc/rollback-rehearsed", description: expect.stringContaining("failed (exit 2)") } });
    expect((await viewOf(dir, "CHG-0017")).deploy.productionGate?.checks[0]?.verdict).toBe("fail");
  }, 30_000);

  it("App mode: the check run carries the rehearsal output verbatim; a re-publish updates the same run", async () => {
    const { dir, gh, env } = await githubSeed(APP);
    const store = new StateStore({ root: dir, identity: ENG });
    const exec: DeployExec = (cmd) => Promise.resolve({ exitCode: 0, output: `${cmd}\nrelease 0 live\n` });
    const head = (await viewOf(dir, "CHG-0017")).pr?.headSha ?? "";
    await deployEnvironment(store, "CHG-0017", "staging", { exec, env });
    await rehearseRollback(store, "CHG-0017", "staging", { exec, env });
    expect(gh.state.statuses).toEqual([]);
    expect(gh.state.checkRuns).toHaveLength(1);
    expect(gh.state.checkRuns[0]).toMatchObject({ name: "sdlc/rollback-rehearsed", head_sha: head, status: "completed", conclusion: "success", output: { title: expect.stringContaining("rollback rehearsed on staging"), text: "echo rollback staging to previous release\nrelease 0 live\n" } });
    // the same check from the committed records, published again (what the CI job does): the run is updated, not stacked
    const repo = loadRepo(await readTree(dir, "HEAD"));
    const files = repo.changes.get("CHG-0017");
    if (!files) throw new Error("CHG-0017");
    expect(await publishRollbackCheck(dir, repo, deriveChange(repo, files), { env })).toEqual([head]);
    expect(gh.state.checkRuns).toHaveLength(1);
  }, 30_000);
});

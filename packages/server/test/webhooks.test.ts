import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, isAncestor, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, realizeSeedRepro, writeSeed } from "@sdlc/fixtures";
import { appendFinding } from "@sdlc/mcp";
import { ActionError, DeliveryLog, Engine, JobStore, SessionRegistry, StateStore, acceptGate, createApp, launchSession, receiveWebhook, type Exec } from "../src/index.js";
import { startFakeGitHub, type FakeGitHub } from "../../adapters/github/test/fake-github.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const SECRET = "wh-s3cret";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function mapLogin(dir: string, id: string, login: string): void {
  const cfg = join(dir, "sdlc/config.yaml");
  const text = readFileSync(cfg, "utf8");
  const marker = `  - id: ${id}\n`;
  if (!text.includes(marker)) throw new Error(`identity ${id} not in config`);
  writeFileSync(cfg, text.replace(marker, `${marker}    github: ${login}\n`));
}

/** Seed repo in GitHub mode with a bare `origin`, a fake API, and the engineer mapped to a GitHub login. */
async function githubSeed(): Promise<{ dir: string; gh: FakeGitHub; env: Record<string, string> }> {
  const base = mkdtempSync(join(tmpdir(), "sdlc-webhooks-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "clone");
  mkdirSync(dir);
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("codeHost: local", "codeHost: github"));
  mapLogin(dir, ENG.id, "eli-gh");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const bare = join(base, "origin.git");
  await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "origin", "main"]);
  const gh = await startFakeGitHub({ bare, owner: "acme", repo: "widgets", protected: true });
  cleanups.push(() => gh.close());
  const env = { GITHUB_TOKEN: gh.token, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets", GITHUB_WEBHOOK_SECRET: SECRET };
  return { dir, gh, env };
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return deriveChange(repo, files);
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });
const red: Exec = (cmd) => Promise.resolve({ exitCode: cmd.includes("test") ? 1 : 0, output: cmd.includes("test") ? "Tests 44 passed · 1 failed" : `${cmd}: ok` });

function harness(dir: string, env: Record<string, string>, opts: { exec?: Exec; syncIntervalMs?: number; webhookQuietMs?: number } = {}) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const deliveries = new DeliveryLog(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, exec: opts.exec ?? green, autoLaunch: false, env, syncIntervalMs: opts.syncIntervalMs ?? 3_600_000, ...(opts.webhookQuietMs !== undefined ? { webhookQuietMs: opts.webhookQuietMs } : {}), now: () => new Date("2026-09-04T09:00:00Z") });
  cleanups.push(() => engine.close());
  const deliver = (eventName: string, payload: unknown, id = `d-${Math.random().toString(36).slice(2, 10)}`, secret = SECRET) => {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return receiveWebhook({ store, engine, deliveries, env }, { headers: { event: eventName, delivery: id, signature }, body });
  };
  return { registry, store, jobs, deliveries, engine, deliver };
}

const REPO = { repository: { name: "widgets", owner: { login: "acme" } } };
const prPayload = (p: { action: string; number: number; headRef: string; headSha: string; merged?: boolean; mergeSha?: string | null; mergedBy?: string | null }) => ({
  ...REPO,
  action: p.action,
  number: p.number,
  pull_request: { number: p.number, state: p.action === "closed" ? "closed" : "open", merged: p.merged ?? false, merge_commit_sha: p.mergeSha ?? null, merged_by: p.mergedBy ? { login: p.mergedBy } : null, head: { ref: p.headRef, sha: p.headSha }, base: { ref: "main" } },
});

/** A build session's commit plus the per-change run: the code PR #1 for CHG-0018 at its tested head. */
async function buildAndRun(h: ReturnType<typeof harness>, dir: string) {
  await h.store.refresh();
  await h.engine.sync(); // drain the first poll before main moves ahead of origin
  const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
  const wt = launched.session.worktreePath;
  await realizeSeedRepro(dir, wt); // 2.7: the fix's repro proof
  mkdirSync(join(wt, "src/export"), { recursive: true });
  writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
  h.registry.patch(launched.session.id, { status: "done" });
  const job = await h.engine.runForSession({ ...launched.session, status: "done" });
  if (job?.state !== "done") throw new Error(`run: ${job?.error ?? job?.state}`);
  return { session: launched.session, worktree: wt, head: (await git(wt, ["rev-parse", "HEAD"])).trim() };
}

async function mergeOnGitHub(gh: FakeGitHub, number: number, login: string): Promise<{ sha: string }> {
  const res = await fetch(`${gh.url}/repos/${gh.owner}/${gh.repo}/pulls/${number}/merge`, { method: "PUT", headers: { Authorization: `Bearer ${gh.token}`, "Content-Type": "application/json", "x-fake-login": login }, body: JSON.stringify({ merge_method: "merge" }) });
  if (!res.ok) throw new Error(`fake merge ${res.status}: ${await res.text()}`);
  return (await res.json()) as { sha: string };
}

/** Someone else pushes a commit to `branch` on origin (a fix pushed from another machine). */
async function pushFromElsewhere(gh: FakeGitHub, branch: string, file: string, content: string, message: string): Promise<string> {
  const clone = mkdtempSync(join(tmpdir(), "sdlc-elsewhere-"));
  cleanups.push(() => rmSync(clone, { recursive: true, force: true }));
  await git(clone, ["clone", "-q", gh.bare, "."]);
  await git(clone, ["config", "user.email", "eng@veri.example"]);
  await git(clone, ["config", "user.name", "Eli Ng"]);
  await git(clone, ["config", "commit.gpgsign", "false"]);
  await git(clone, ["checkout", "-q", branch]);
  mkdirSync(join(clone, file, ".."), { recursive: true });
  writeFileSync(join(clone, file), content);
  await git(clone, ["add", "-A"]);
  await git(clone, ["commit", "-q", "-m", message]);
  await git(clone, ["push", "-q", "origin", branch]);
  return (await git(clone, ["rev-parse", "HEAD"])).trim();
}

describe("webhook receiver (2.4): signature first, then replay, then repository, then the engine", () => {
  it("answers 503 without a secret, 401 on a bad signature, 400 without a delivery id, pong on ping, replay on a redelivered id, 202 for another repository", async () => {
    const { dir, env } = await githubSeed();
    const h = harness(dir, env);
    await h.store.refresh();
    const ping = { ...REPO, zen: "Practicality beats purity." };
    const off = await receiveWebhook({ store: h.store, engine: h.engine, deliveries: h.deliveries, env: { ...env, GITHUB_WEBHOOK_SECRET: undefined } as never }, { headers: { event: "ping", delivery: "d-1", signature: undefined }, body: Buffer.from(JSON.stringify(ping)) });
    expect(off.status).toBe(503);
    expect(String(off.body["error"])).toContain("GITHUB_WEBHOOK_SECRET");
    expect((await h.deliver("ping", ping, "d-1", "wrong")).status).toBe(401);
    expect((await h.deliver("ping", ping, "")).status).toBe(400);
    const ok = await h.deliver("ping", ping, "d-ping");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, replay: false, delivery: { id: "d-ping", event: "ping", outcome: "pong", status: 200 } });
    const again = await h.deliver("ping", ping, "d-ping");
    expect(again.body).toMatchObject({ ok: true, replay: true, delivery: { id: "d-ping", outcome: "pong" } });
    const foreign = await h.deliver("push", { repository: { name: "gadgets", owner: { login: "acme" } }, ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) }, "d-foreign");
    expect(foreign.status).toBe(202);
    expect(String((foreign.body["delivery"] as { outcome: string }).outcome)).toContain("acme/gadgets");
    expect(h.deliveries.recent().map((d) => d.id)).toEqual(["d-foreign", "d-ping"]);
    // a delivery the engine cannot act on is not recorded: GitHub's redelivery reprocesses it
    expect(h.deliveries.get("d-1")).toBeNull();
  });

  it("over HTTP: POST /api/webhooks/github verifies the raw body; GET /api/webhooks reports the receiver", async () => {
    const { dir, env } = await githubSeed();
    const h = harness(dir, env);
    await h.store.refresh();
    const app = createApp(h.store, { registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", engine: h.engine, jobs: h.jobs, deliveries: h.deliveries, env });
    cleanups.push(() => app.close());
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const body = JSON.stringify({ ...REPO, zen: "Anything added dilutes everything else." });
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const bad = await fetch(`${url}/api/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "h-1", "x-hub-signature-256": sig }, body: `${body} ` });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${url}/api/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "h-1", "x-hub-signature-256": sig }, body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, replay: false, delivery: { outcome: "pong" } });
    const status = (await (await fetch(`${url}/api/webhooks`)).json()) as { enabled: boolean; secretSet: boolean; lastDeliveryAt: string | null; deliveries: { id: string }[] };
    expect(status).toMatchObject({ enabled: true, secretSet: true, deliveries: [{ id: "h-1" }] });
    expect(status.lastDeliveryAt).not.toBeNull();
  });
});

describe("merge detected through the webhook → stage 6, idempotent on replay (2.4)", () => {
  it("pull_request.closed{merged} records gate 5 under the identity mapped to the merger; the same event with a new delivery id finds it already recorded", async () => {
    const { dir, gh, env } = await githubSeed();
    const h = harness(dir, env);
    const { head } = await buildAndRun(h, dir);
    expect((await viewOf(dir, "CHG-0018")).stage).toBe(5);
    const { sha: mergeSha } = await mergeOnGitHub(gh, 1, "eli-gh");
    const r = await h.deliver("pull_request", prPayload({ action: "closed", number: 1, headRef: "CHG-0018/export-fix", headSha: head, merged: true, mergeSha, mergedBy: "eli-gh" }), "d-merge");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ delivery: { changeId: "CHG-0018", outcome: "CHG-0018: gate 5 recorded from PR #1 merged by eli-gh" } });
    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(6);
    expect(view.pr?.mergeSha).toBe(mergeSha);
    expect(view.activity.find((a) => a.event === "pr.merged")).toMatchObject({ actor: "human", actorId: ENG.id });
    expect((await git(dir, ["show", "-s", "--format=%an <%ae>", "HEAD"])).trim()).toBe("Eli Ng <eng@veri.example>");
    expect(await isAncestor(dir, mergeSha, "main")).toBe(true);
    const commits = Number((await git(dir, ["rev-list", "--count", "HEAD"])).trim());
    // a redelivery is a replay; a re-sent event under a new id changes nothing in git
    expect((await h.deliver("pull_request", prPayload({ action: "closed", number: 1, headRef: "CHG-0018/export-fix", headSha: head, merged: true, mergeSha, mergedBy: "eli-gh" }), "d-merge")).body).toMatchObject({ replay: true });
    const resent = await h.deliver("pull_request", prPayload({ action: "closed", number: 1, headRef: "CHG-0018/export-fix", headSha: head, merged: true, mergeSha, mergedBy: "eli-gh" }), "d-merge-2");
    expect(resent.body).toMatchObject({ replay: false, delivery: { outcome: "CHG-0018: PR #1 merge already recorded" } });
    expect(Number((await git(dir, ["rev-list", "--count", "HEAD"])).trim())).toBe(commits);
    expect((await viewOf(dir, "CHG-0018")).activity.filter((a) => a.event === "pr.merged")).toHaveLength(1);
    // a PR the console never recorded
    const unknown = await h.deliver("pull_request", prPayload({ action: "closed", number: 42, headRef: "feature/x", headSha: "c".repeat(40), merged: true, mergeSha: "d".repeat(40), mergedBy: "eli-gh" }));
    expect(unknown.body).toMatchObject({ delivery: { outcome: "PR #42 merged: not a recorded pull request", changeId: null } });
  }, 60_000);
});

describe("pull_request.synchronize: the code PR follows its tested head (2.4)", () => {
  it("fetches the new head into the branch worktree, runs on it, publishes the checks on it, records pr.synchronized; the old head's review and findings are history; a red run leaves the tested head as the merge precondition", async () => {
    const { dir, gh, env } = await githubSeed();
    const h = harness(dir, env);
    const { worktree, head: h1 } = await buildAndRun(h, dir);
    // the first head is reviewed
    const review = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
    appendFinding(worktree, review.session.id, { n: 1, ts: "2026-09-04T09:05:00Z", severity: "high", title: "zero-total rows are still filtered", path: "src/export/csv.ts" });
    h.registry.patch(review.session.id, { status: "done" });
    expect((await h.engine.mirrorForSession({ ...review.session, status: "done" }))?.state).toBe("done");
    let view = await viewOf(dir, "CHG-0018");
    expect(view.pr?.review?.headSha).toBe(h1);
    expect(view.findings).toHaveLength(1);

    // a fix is pushed from elsewhere; GitHub delivers synchronize
    const h2 = await pushFromElsewhere(gh, "CHG-0018/export-fix", "src/export/csv.ts", "export const fixed = true;\nexport const zeroKept = true;\n", "keep zero-total rows");
    const r = await h.deliver("pull_request", prPayload({ action: "synchronize", number: 1, headRef: "CHG-0018/export-fix", headSha: h2 }), "d-sync");
    expect(r.body).toMatchObject({ ok: true, delivery: { changeId: "CHG-0018", outcome: `CHG-0018: run on ${h2.slice(0, 7)} → run 3 green · PR head → ${h2.slice(0, 7)}` } });
    expect(r.status).toBe(200);
    expect((await git(worktree, ["rev-parse", "HEAD"])).trim()).toBe(h2);
    view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.pr).toMatchObject({ number: 1, headSha: h2, checks: [expect.objectContaining({ name: "evidence", verdict: "pass" }), expect.objectContaining({ name: "evals", verdict: "pass" }), expect.objectContaining({ name: "repro", verdict: "pass" })] });
    expect(view.pr?.review).toBeUndefined();
    expect(view.pr?.findings).toBeUndefined();
    expect(view.findings).toEqual([]);
    expect(view.latestRun).toMatchObject({ n: 3, headSha: h2, verdict: "green" });
    const synced = view.activity.find((a) => a.event === "pr.synchronized");
    expect(synced?.text).toBe(`PR #1 head moved to ${h2.slice(0, 7)} — run green on the new head`);
    expect(synced?.actor).toBe("system");
    expect(gh.state.pulls).toHaveLength(1);
    expect(gh.state.statuses.filter((s) => s.sha === h2).map((s) => s.body["context"])).toEqual(["sdlc/evidence", "sdlc/evals", "sdlc/repro"]);
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe(`sdlc(CHG-0018): PR #1 head → ${h2.slice(0, 7)}`);
    expect(h.jobs.list().filter((j) => j.kind === "per-change-run").map((j) => j.key)).toContainEqual(expect.stringContaining(`${h2.slice(0, 12)}:webhook`));
    // the same head again: nothing to run
    const same = await h.deliver("pull_request", prPayload({ action: "synchronize", number: 1, headRef: "CHG-0018/export-fix", headSha: h2 }), "d-sync-2");
    expect(same.body).toMatchObject({ delivery: { outcome: `CHG-0018: PR head ${h2.slice(0, 7)} is already the tested head` } });
    // the push delivery for the same branch defers to synchronize
    const push = await h.deliver("push", { ...REPO, ref: "refs/heads/CHG-0018/export-fix", before: h1, after: h2 });
    expect(push.body).toMatchObject({ delivery: { outcome: "push to CHG-0018/export-fix (CHG-0018): the pull_request.synchronize delivery runs the new head", changeId: "CHG-0018" } });

    // a third head whose run is red: pr.yaml keeps h2, and the merge precondition refuses at GitHub
    const redEngine = harness(dir, env, { exec: red });
    const h3 = await pushFromElsewhere(gh, "CHG-0018/export-fix", "src/export/csv.ts", "export const fixed = false;\n", "regress");
    const r3 = await redEngine.deliver("pull_request", prPayload({ action: "synchronize", number: 1, headRef: "CHG-0018/export-fix", headSha: h3 }), "d-sync-3");
    expect(String((r3.body["delivery"] as { outcome: string }).outcome)).toBe(`CHG-0018: run on ${h3.slice(0, 7)} → run 4 red`);
    view = await viewOf(dir, "CHG-0018");
    expect(view.pr?.headSha).toBe(h2);
    expect(view.latestRun).toMatchObject({ n: 4, headSha: h3, verdict: "red" });
    expect(view.stage).toBe(5);
    const err = await acceptGate(redEngine.store, "CHG-0018", 5, env).catch((e: unknown) => e as ActionError);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).retryable).toBe(true);
    expect(gh.state.pulls[0]?.merged).toBe(false);
  }, 90_000);
});

async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("push to the default branch, and polling as the fallback (2.4)", () => {
  it("origin/main moving brings the local default branch up; while deliveries arrive the poll backs off, without them it runs every tick", async () => {
    const { dir, gh, env } = await githubSeed();
    const h = harness(dir, env, { syncIntervalMs: 0, webhookQuietMs: 3_600_000 });
    await h.store.refresh();
    expect(h.engine.pollInterval()).toBe(0);
    // the refresh above already woke the engine; ticks coalesce, so wait for the poll it started
    await h.engine.tick();
    await waitFor(() => h.engine.lastSyncAt > 0);
    const after = await pushFromElsewhere(gh, "main", "docs/NOTE.md", "pushed elsewhere\n", "docs: note");
    const r = await h.deliver("push", { ...REPO, ref: "refs/heads/main", before: "0".repeat(40), after }, "d-push");
    expect(r.body).toMatchObject({ delivery: { outcome: `origin/main moved to ${after.slice(0, 7)}: synced (0 merge(s) recorded)` } });
    expect(await isAncestor(dir, after, "main")).toBe(true);
    // the delivery's own sync counts as the last poll; from here ticks back off for an hour
    expect(h.engine.pollInterval()).toBe(3_600_000);
    const afterDelivery = h.engine.lastSyncAt;
    await new Promise((r) => setTimeout(r, 5));
    await h.engine.tick();
    expect(h.engine.lastSyncAt).toBe(afterDelivery);
    // without the back-off (no quiet window) the same tick polls again: polling is the fallback, not switched off
    const eager = harness(dir, env, { syncIntervalMs: 0, webhookQuietMs: 0 });
    await eager.store.refresh();
    await waitFor(() => eager.engine.lastSyncAt > 0);
    await eager.deliver("ping", { ...REPO, zen: "Mind your words, they are important." });
    const before = eager.engine.lastSyncAt;
    expect(eager.engine.pollInterval()).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    await eager.engine.tick();
    await waitFor(() => eager.engine.lastSyncAt > before);
    // deleted branches and untracked branches are noted, never fetched
    expect((await h.deliver("push", { ...REPO, ref: "refs/heads/feature/x", before: after, after: "0".repeat(40), deleted: true })).body).toMatchObject({ delivery: { outcome: "feature/x deleted on origin: nothing to do" } });
    expect((await h.deliver("push", { ...REPO, ref: "refs/heads/feature/x", before: "0".repeat(40), after })).body).toMatchObject({ delivery: { outcome: "push to feature/x: not a branch the console tracks" } });
    expect((await h.deliver("pull_request_review", { ...REPO, action: "submitted", review: { state: "approved", user: { login: "lee" } }, pull_request: { number: 9, head: { sha: after } } })).body).toMatchObject({ delivery: { outcome: "review approved by lee on PR #9 noted; gate decisions are recorded from merges" } });
    expect((await h.deliver("check_run", { ...REPO, action: "completed", check_run: { name: "ci", status: "completed", conclusion: "success", head_sha: after } })).body).toMatchObject({ delivery: { outcome: `check ci success on ${after.slice(0, 7)}: no recorded PR head` } });
    expect((await h.deliver("issues", { ...REPO, action: "opened" })).body).toMatchObject({ delivery: { outcome: "ignored issues.opened" } });
  }, 60_000);
});

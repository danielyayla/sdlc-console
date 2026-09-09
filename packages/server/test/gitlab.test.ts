import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodeHostError, addWorktree, commitWritePlan, git, initRepo, isAncestor, newUlid, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, realizeSeedRepro, writeSeed } from "@sdlc/fixtures";
import { appendFinding } from "@sdlc/mcp";
import { parseFrontMatter, stringifyFrontMatter } from "@sdlc/schemas";
import { ActionError, DeliveryLog, Engine, JobStore, SessionRegistry, StateStore, acceptGate, codeHostFor, createApp, launchSession, newChange, publishRollbackCheck, receiveGitLabWebhook, sendBackGate, type Exec } from "../src/index.js";
import { startFakeGitLab, type FakeGitLab } from "../../adapters/gitlab/test/fake-gitlab.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const PO_ID = { id: PO, name: "Priya Owens" };
const AGENT = { id: "claude-code@sdlc.local", name: "claude-code" };
const SECRET = "gl-wh-s3cret";
const MR1 = "https://gitlab.example/acme/widgets/-/merge_requests/1";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function mapLogin(dir: string, id: string, username: string): void {
  const cfg = join(dir, "sdlc/config.yaml");
  const text = readFileSync(cfg, "utf8");
  const marker = `  - id: ${id}\n`;
  if (!text.includes(marker)) throw new Error(`identity ${id} not in config`);
  writeFileSync(cfg, text.replace(marker, `${marker}    gitlab: ${username}\n`));
}

/** Seed repo in GitLab mode with a bare `origin` and a fake REST v4 API in front of it. */
async function gitlabSeed(opts: { protected?: boolean; logins?: Record<string, string> } = {}): Promise<{ dir: string; gl: FakeGitLab; env: Record<string, string> }> {
  const base = mkdtempSync(join(tmpdir(), "sdlc-gitlab-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "clone");
  mkdirSync(dir);
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("codeHost: local", "codeHost: gitlab"));
  for (const [id, login] of Object.entries(opts.logins ?? {})) mapLogin(dir, id, login);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const bare = join(base, "origin.git");
  await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "origin", "main"]);
  const gl = await startFakeGitLab({ bare, path: "acme/widgets", protected: opts.protected ?? true });
  cleanups.push(() => gl.close());
  const env = { GITLAB_TOKEN: gl.token, CI_API_V4_URL: gl.url, CI_PROJECT_PATH: "acme/widgets", SDLC_GITLAB_WEBHOOK_SECRET: SECRET };
  return { dir, gl, env };
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
  const deliveries = new DeliveryLog(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, exec: green, autoLaunch: false, env, syncIntervalMs: 3_600_000, now: () => new Date("2026-09-08T09:00:00Z") });
  cleanups.push(() => engine.close());
  /** `uuid: null` sends no X-Gitlab-Event-UUID (an older instance); undefined picks a fresh one. */
  const deliver = (eventName: string, payload: unknown, uuid: string | null = `u-${Math.random().toString(36).slice(2, 10)}`, token = SECRET) =>
    receiveGitLabWebhook({ store, engine, deliveries, env }, { headers: { event: eventName, uuid: uuid ?? undefined, token }, body: Buffer.from(JSON.stringify(payload)) });
  return { registry, store, jobs, deliveries, engine, deliver };
}

async function buildAndRun(dir: string, env: Record<string, string>) {
  const h = harness(dir, env);
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
  return { ...h, job, session: launched.session, worktree: wt };
}

/** Draft spec.md for CHG-0022 on sdlc/CHG-0022/spec, the way propose_artifact would. */
async function draftSpec(dir: string, intentSha: string, note = "") {
  const branch = "sdlc/CHG-0022/spec";
  const wt = join(dir, ".sdlc-state", "worktrees", "sdlc-CHG-0022-spec");
  if (!existsSync(wt)) await addWorktree(dir, wt, branch, "main");
  const src = parseFrontMatter(readFileSync(join(dir, "sdlc/changes/CHG-0021/spec.md"), "utf8"), "spec.md");
  if (!src.ok || !src.value) throw new Error("seed spec unreadable");
  const text = stringifyFrontMatter({ ...src.value.data, id: "CHG-0022", intent_sha: intentSha, created: "2026-09-08T10:00:00Z" }, `${src.value.body}${note}`);
  const events = (await git(dir, ["show", `${branch}:sdlc/changes/CHG-0022/log.jsonl`])).trim().split("\n");
  const event = { schema: 1, id: newUlid(), ts: "2026-09-08T10:00:00Z", seq: events.length + 1, cycle: 1, actor: { type: "agent", id: AGENT.id, session: "s-test" }, event: "artifact.committed", data: { artifact: 1, path: "sdlc/changes/CHG-0022/spec.md", sha: "c".repeat(40) } };
  await commitWritePlan(wt, { changeId: "CHG-0022", files: [{ path: "sdlc/changes/CHG-0022/spec.md", content: text }], events: [{ changeId: "CHG-0022", event: event as never }], commitMessage: "sdlc(CHG-0022): propose spec.md", trailers: { "SDLC-Actor": `agent:${AGENT.id}` }, actor: { type: "agent" as const, id: AGENT.id, session: "s-test" } }, { identity: AGENT });
  return { branch, wt };
}

/** A human merges on GitLab itself. */
async function mergeOnGitLab(gl: FakeGitLab, iid: number, username: string): Promise<{ sha: string }> {
  const res = await fetch(`${gl.url}/projects/${encodeURIComponent(gl.path)}/merge_requests/${iid}/merge`, { method: "PUT", headers: { "PRIVATE-TOKEN": gl.token, "Content-Type": "application/json", "x-fake-username": username }, body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`fake merge ${res.status}: ${await res.text()}`);
  return { sha: String(((await res.json()) as { merge_commit_sha: string }).merge_commit_sha) };
}

const PROJECT = { project: { path_with_namespace: "acme/widgets" } };
const mrHook = (p: { action: string; iid: number; source: string; headSha: string; state?: string; mergeSha?: string | null; user?: string; oldrev?: string }) => ({
  ...PROJECT,
  object_kind: "merge_request",
  user: { username: p.user ?? "eli-gl" },
  object_attributes: { iid: p.iid, source_branch: p.source, target_branch: "main", last_commit: { id: p.headSha }, state: p.state ?? (p.action === "merge" ? "merged" : "opened"), action: p.action, merge_commit_sha: p.mergeSha ?? null, ...(p.oldrev ? { oldrev: p.oldrev } : {}) },
});

describe("GitLab mode (3.7): green run pushes the branch, opens a merge request, gate 5 merges through the API under a protected target branch", () => {
  it("opens the MR with the checks as commit statuses, mirrors iid/url/head into pr.yaml (provider gitlab) → stage 5; the merge records mergeSha and the production gate's status is published", async () => {
    const { dir, gl, env } = await gitlabSeed();
    const { job, store } = await buildAndRun(dir, env);
    expect(job?.state).toBe("done");
    expect(job?.note).toContain("PR opened");
    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.pr).toMatchObject({ provider: "gitlab", number: 1, url: MR1, branch: "CHG-0018/export-fix", baseBranch: "main", checks: [expect.objectContaining({ name: "evidence", verdict: "pass" }), expect.objectContaining({ name: "evals", verdict: "pass" }), expect.objectContaining({ name: "repro", verdict: "pass" })] });
    const pushed = (await git(gl.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();
    expect(view.pr?.headSha).toBe(pushed);
    expect(gl.state.mergeRequests[0]).toMatchObject({ source_branch: "CHG-0018/export-fix", target_branch: "main", title: expect.stringContaining("sdlc(CHG-0018)"), description: expect.stringContaining("sdlc/changes/CHG-0018/plan.md") });
    // the checks: external statuses on the head, shown in the MR pipeline widget (GitLab has no check-runs API)
    expect(gl.state.statuses).toEqual([
      { sha: pushed, body: { state: "success", name: "sdlc/evidence", description: expect.stringContaining("green"), target_url: MR1 } },
      { sha: pushed, body: { state: "success", name: "sdlc/evals", description: expect.stringContaining("eval cases"), target_url: MR1 } },
      { sha: pushed, body: { state: "success", name: "sdlc/repro", description: expect.stringContaining("unchanged in diff"), target_url: MR1 } },
    ]);
    // the token never travelled in a URL or an Authorization header (the fake answers 401 to both)
    expect(gl.state.requests.every((r) => r.privateToken === gl.token)).toBe(true);
    expect((await git(gl.bare, ["rev-parse", "refs/heads/main"])).trim()).not.toBe((await git(dir, ["rev-parse", "main"])).trim());

    // gate 5: the engineer merges through the API; the merge commit made by GitLab lands on local main
    const r = await acceptGate(store, "CHG-0018", 5, env);
    expect(r.toast).toContain("Maintain");
    const after = await viewOf(dir, "CHG-0018");
    expect(after.stage).toBe(6);
    const originMain = (await git(gl.bare, ["rev-parse", "refs/heads/main"])).trim();
    expect(after.pr?.mergeSha).toBe(originMain);
    expect(gl.state.mergeRequests[0]).toMatchObject({ state: "merged", merge_commit_sha: originMain, merged_by: "token-user" });
    expect(await isAncestor(dir, originMain, "main")).toBe(true);
    expect(await isAncestor(dir, pushed, "main")).toBe(true);
    const merged = after.activity.find((a) => a.event === "pr.merged");
    expect(merged?.actor).toBe("human");
    expect(after.activity.find((a) => a.event === "gate.accepted" && a.text.includes("5"))).toBeTruthy();
    const originLog = await git(gl.bare, ["show", "refs/heads/main:sdlc/changes/CHG-0018/log.jsonl"]).catch(() => "");
    void originLog; // lifecycle records reach origin through the records MR, not the code MR
    // a second accept is refused by GitLab (405 once merged), not retried around
    const again = await acceptGate(store, "CHG-0018", 5, env).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ActionError);

    // 3.6 in GitLab mode: the production gate's check is a commit status on the merge commit and the tested head
    await store.refresh(true);
    const repo = store.currentRepo;
    if (!repo) throw new Error("repo");
    const published = await publishRollbackCheck(dir, repo, after, { env });
    expect(published.sort()).toEqual([originMain, pushed].sort());
    const gate = gl.state.statuses.filter((s) => s.body["name"] === "sdlc/rollback-rehearsed");
    expect(gate.map((s) => s.sha).sort()).toEqual([originMain, pushed].sort());
    expect(gate[0]?.body).toMatchObject({ state: "pending", target_url: MR1 });
  }, 40_000);

  it("refuses to push or open an MR when the target branch is unprotected — no fallback", async () => {
    const { dir, gl, env } = await gitlabSeed({ protected: false });
    const { job } = await buildAndRun(dir, env);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("not protected");
    expect(gl.state.mergeRequests).toHaveLength(0);
    expect((await git(gl.bare, ["branch", "--list", "CHG-0018/export-fix"])).trim()).toBe("");
    const view = await viewOf(dir, "CHG-0018");
    expect(view.latestRun?.verdict).toBe("green");
    expect(view.pr).toBeNull();
  }, 30_000);

  it("merge is refused with a retryable error when the MR head moved after the tested run (GitLab 409)", async () => {
    const { dir, gl, env } = await gitlabSeed();
    const { store, worktree } = await buildAndRun(dir, env);
    writeFileSync(join(worktree, "src/export/late.ts"), "export const late = 1;\n");
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["commit", "-q", "-m", "late push"]);
    await git(worktree, ["push", "-q", "origin", "HEAD:CHG-0018/export-fix"]);
    const err = await acceptGate(store, "CHG-0018", 5, env).catch((e: unknown) => e as ActionError);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(502);
    expect((err as ActionError).retryable).toBe(true);
    expect((err as ActionError).message).toContain("SHA does not match");
    expect(gl.state.mergeRequests[0]?.state).toBe("opened");
    expect((await viewOf(dir, "CHG-0018")).stage).toBe(5);
  }, 30_000);

  it("GitLab mode without a token refuses instead of falling back to a local merge", () => {
    const err = (() => {
      try {
        codeHostFor("gitlab", {});
        return null;
      } catch (e) {
        return e as CodeHostError;
      }
    })();
    expect(err).toBeInstanceOf(CodeHostError);
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain("GITLAB_TOKEN");
    expect(codeHostFor("gitlab", { GITLAB_TOKEN: "glpat-x" }).provider).toBe("gitlab");
  });
});

describe("artifact merge requests as gates in GitLab mode (2.2 behind the same contract)", () => {
  it("spec drafted on its branch → engine opens the MR → send back posts a note → accept merges the MR → stage 3; the records MR carries the console's commits and a human merges it", async () => {
    const { dir, gl, env } = await gitlabSeed({ logins: { [PO]: "priya-gl" } });
    const { engine } = harness(dir, env);
    const po = new StateStore({ root: dir, identity: PO_ID });
    const g1 = await acceptGate(po, "CHG-0022", 1, env);
    expect(g1.toast).toContain("Design");
    const intentSha = (await viewOf(dir, "CHG-0022")).docs[0].sha ?? "";
    const { branch } = await draftSpec(dir, intentSha);
    let sync = await engine.sync();
    expect(sync?.opened).toEqual([{ changeId: "CHG-0022", artifact: 1, branch, number: 1, url: MR1 }]);
    expect(sync?.records).toMatchObject({ ahead: 1, pushed: true, number: 2, url: "https://gitlab.example/acme/widgets/-/merge_requests/2" });
    expect(gl.state.mergeRequests[0]).toMatchObject({ source_branch: branch, target_branch: "main", title: expect.stringContaining("spec.md for review"), description: expect.stringContaining("Merging this merge request is the gate decision") });
    expect(gl.state.mergeRequests[1]).toMatchObject({ source_branch: "sdlc/records", title: "sdlc: lifecycle records" });
    expect(await git(gl.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/log.jsonl`])).toContain('"artifact":1,"branch":"sdlc/CHG-0022/spec"');
    const snap = await po.refresh(true);
    let v = snap.changes.find((c) => c.id === "CHG-0022");
    expect(v?.stage).toBe(2);
    expect(v?.docs[1].state).toBe("pending-review");
    expect(v?.artifactPrs[1]).toMatchObject({ number: 1, url: MR1, branch, merged: false });
    sync = await engine.sync();
    expect(sync?.opened).toEqual([]);

    // send back: the event lands on the branch and the MR gets a note with the feedback
    const sb = await sendBackGate(po, "CHG-0022", 2, "resolve concern C1 before review", env);
    expect(sb.toast).toContain("sent back on MR !1");
    expect(gl.state.notes).toEqual([{ iid: 1, body: "**Sent back** — resolve concern C1 before review" }]);
    expect(await git(gl.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/log.jsonl`])).toContain('"gate.sent_back"');
    await draftSpec(dir, intentSha, "\nC1 resolved with marketing.\n");
    sync = await engine.sync();
    expect(sync?.pushed).toMatchObject([{ changeId: "CHG-0022", artifact: 1, branch, number: 1 }]);
    expect(await git(gl.bare, ["show", `refs/heads/${branch}:sdlc/changes/CHG-0022/spec.md`])).toContain("C1 resolved");

    // accept: decision committed on the branch, MR merged through the API, spec + decision now on main
    const g2 = await acceptGate(po, "CHG-0022", 2, env);
    expect(g2.toast).toContain("MR !1 merged");
    expect(gl.state.mergeRequests[0]).toMatchObject({ state: "merged", merged_by: "token-user" });
    const originLog = await git(gl.bare, ["show", "refs/heads/main:sdlc/changes/CHG-0022/log.jsonl"]);
    expect(originLog).toContain('"gate":2');
    expect(originLog).toContain('"source":"pr.merge"');
    v = await viewOf(dir, "CHG-0022");
    expect(v.stage).toBe(3);
    expect(v.artifactPrs[1]?.merged).toBe(true);
    expect(v.acceptedGates).toEqual([1, 2]);
    expect((await po.refresh(true)).branches).toEqual([]);

    // a console-only decision stays local until the records MR merges; a human merges it on GitLab and the next pass is in sync
    await sendBackGate(po, "CHG-0021", 2, "needs the pricing table", env);
    sync = await engine.sync();
    expect(sync?.records).toMatchObject({ ahead: 1, pushed: true, number: 2 });
    await mergeOnGitLab(gl, 2, "priya-gl");
    sync = await engine.sync();
    expect(sync?.records).toEqual({ ahead: 0, pushed: false });
    expect(await git(gl.bare, ["show", "refs/heads/main:sdlc/changes/CHG-0021/log.jsonl"])).toContain('"gate.sent_back"');
    void snap;
  }, 60_000);

  it("a change born on sdlc/<CHG>/intent gets its intent MR; an MR merged on GitLab is recorded under the identity whose `gitlab` login matches, an unmapped merger is not guessed", async () => {
    const { dir, gl, env } = await gitlabSeed({ logins: { [PO]: "priya-gl" } });
    const { engine } = harness(dir, env);
    const po = new StateStore({ root: dir, identity: PO_ID });
    await po.refresh();
    const created = await newChange(po, { title: "Nightly digest", kind: "feature", risk: "routine", origin: { type: "idea" }, intentBody: "# Intent: Nightly digest\n\n## Problem\nNo digest.\n\n## Proposed outcome\nA digest.\n\n## Affected users and systems\nMail.\n\n## Constraints\nNone.\n\n## Open questions\nNone.\n" });
    const id = created.changeId ?? "";
    expect(created.toast).toContain(`created on sdlc/${id}/intent`);
    const sync1 = await engine.sync();
    expect(sync1?.opened).toMatchObject([{ changeId: id, artifact: 0, branch: `sdlc/${id}/intent`, number: 1 }]);
    // the product owner merges on GitLab itself: gate 1 recorded under her identity
    await mergeOnGitLab(gl, 1, "priya-gl");
    const sync2 = await engine.sync();
    expect(sync2?.merges).toEqual([{ changeId: id, gate: 1, number: 1, mergedBy: "priya-gl", recorded: true }]);
    const v = await viewOf(dir, id);
    expect(v.stage).toBe(2);
    expect(v.activity.find((a) => a.event === "gate.accepted")).toMatchObject({ actor: "human", actorId: PO });
    expect((await git(dir, ["show", "-s", "--format=%an <%ae>", "HEAD"])).trim()).toBe("Priya Owens <po@veri.example>");

    // a stranger merges the spec MR: taken from origin, not recorded, and the owner still decides in the console
    await acceptGate(po, "CHG-0022", 1, env);
    const intentSha = (await viewOf(dir, "CHG-0022")).docs[0].sha ?? "";
    await draftSpec(dir, intentSha);
    await engine.sync();
    const specMr = gl.state.mergeRequests.find((m) => m.source_branch === "sdlc/CHG-0022/spec");
    if (!specMr) throw new Error("spec MR not opened");
    await mergeOnGitLab(gl, specMr.iid, "stranger");
    const sync3 = await engine.sync();
    expect(sync3?.merges.find((m) => m.changeId === "CHG-0022")).toMatchObject({ gate: 2, mergedBy: "stranger", recorded: false, reason: expect.stringContaining("does not hold") });
    expect((await viewOf(dir, "CHG-0022")).acceptedGates).toEqual([1]);
    const g2 = await acceptGate(po, "CHG-0022", 2, env);
    expect(g2.toast).toContain("Build");
    expect((await viewOf(dir, "CHG-0022")).stage).toBe(3);
  }, 60_000);
});

describe("review findings reach the merge request (2.3 on GitLab)", () => {
  it("a review session's findings become the sdlc/findings status on the reviewed head and a note with the findings verbatim — never an approval", async () => {
    const { dir, gl, env } = await gitlabSeed();
    const h = await buildAndRun(dir, env);
    expect(h.job?.state).toBe("done");
    const pushed = (await git(gl.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();
    const review = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
    appendFinding(h.worktree, review.session.id, { n: 1, ts: "2026-09-08T09:05:00Z", severity: "high", title: "export drops rows whose amount is 0", path: "src/export/csv.ts", detail: "rows.filter(Boolean) removes { amount: 0 }" });
    appendFinding(h.worktree, review.session.id, { n: 2, ts: "2026-09-08T09:06:00Z", severity: "low", title: "no test for the empty export" });
    h.registry.patch(review.session.id, { status: "done" });
    const job = await h.engine.mirrorForSession({ ...review.session, status: "done" });
    expect(job?.state).toBe("done");
    const view = await viewOf(dir, "CHG-0018");
    expect(view.pr?.findings).toEqual({ high: 1, medium: 0, low: 1 });
    expect(view.pr?.checks.map((c) => [c.name, c.verdict])).toEqual([["evidence", "pass"], ["evals", "pass"], ["repro", "pass"], ["findings", "fail"]]);
    expect(gl.state.statuses.at(-1)).toEqual({ sha: pushed, body: { state: "failed", name: "sdlc/findings", description: `review of ${pushed.slice(0, 7)}: 1 high · 0 medium · 1 low`, target_url: MR1 } });
    expect(gl.state.notes).toHaveLength(1);
    const body = gl.state.notes[0]?.body ?? "";
    expect(body).toContain("- **high** export drops rows whose amount is 0 — `src/export/csv.ts`");
    expect(body).toContain("rows.filter(Boolean) removes { amount: 0 }");
    expect(body).toContain("- **low** no test for the empty export");
    expect(body).toContain("Findings inform; a code owner approves and merges.");
    // findings inform: the engineer still merges through the API
    const r = await acceptGate(h.store, "CHG-0018", 5, env);
    expect(r.toast).toContain("Maintain");
    expect((await viewOf(dir, "CHG-0018")).stage).toBe(6);
  }, 40_000);
});

describe("GitLab webhook receiver (3.7): token first, then replay, then project, then the engine", () => {
  it("answers 503 without a secret, 401 on a wrong token, 400 without an event header, replays by UUID and by body hash, 202 for another project", async () => {
    const { dir, env } = await gitlabSeed();
    const h = harness(dir, env);
    await h.store.refresh();
    const push = { ...PROJECT, object_kind: "push", ref: "refs/heads/feature/x", before: "a".repeat(40), after: "b".repeat(40) };
    const off = await receiveGitLabWebhook({ store: h.store, engine: h.engine, deliveries: h.deliveries, env: { ...env, SDLC_GITLAB_WEBHOOK_SECRET: undefined } as never }, { headers: { event: "Push Hook", uuid: "u-1", token: undefined }, body: Buffer.from(JSON.stringify(push)) });
    expect(off.status).toBe(503);
    expect(String(off.body["error"])).toContain("SDLC_GITLAB_WEBHOOK_SECRET");
    expect((await h.deliver("Push Hook", push, "u-1", "wrong")).status).toBe(401);
    expect((await h.deliver("", push, "u-1")).status).toBe(400);
    const ok = await h.deliver("Push Hook", push, "u-push");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, replay: false, delivery: { id: "u-push", event: "Push Hook", outcome: "push to feature/x: not a branch the console tracks", status: 200 } });
    expect((await h.deliver("Push Hook", push, "u-push")).body).toMatchObject({ replay: true, delivery: { id: "u-push" } });
    // no UUID (older GitLab): the same body re-sent is the same delivery
    const first = await h.deliver("Push Hook", push, null);
    expect(first.body).toMatchObject({ replay: false });
    expect(String((first.body["delivery"] as { id: string }).id)).toMatch(/^body-sha256:[0-9a-f]{64}$/);
    expect((await h.deliver("Push Hook", push, null)).body).toMatchObject({ replay: true });
    const foreign = await h.deliver("Push Hook", { ...push, project: { path_with_namespace: "acme/gadgets" } }, "u-foreign");
    expect(foreign.status).toBe(202);
    expect(String((foreign.body["delivery"] as { outcome: string }).outcome)).toContain("acme/gadgets");
    expect(h.deliveries.get("u-1")).toBeNull();
  });

  it("Merge Request Hook{merge} records gate 5 under the identity mapped to the merger's gitlab username, idempotent on replay; Pipeline Hook is noted; Push Hook to main syncs", async () => {
    const { dir, gl, env } = await gitlabSeed({ logins: { [ENG.id]: "eli-gl" } });
    const h = harness(dir, env);
    const { job } = await buildAndRun(dir, env);
    expect(job?.state).toBe("done");
    const head = (await git(gl.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();
    // a pipeline on the MR head: noted, never a decision
    const pipe = await h.deliver("Pipeline Hook", { ...PROJECT, object_kind: "pipeline", object_attributes: { sha: head, ref: "CHG-0018/export-fix", status: "success" } }, "u-pipe");
    expect(pipe.body).toMatchObject({ delivery: { changeId: "CHG-0018", outcome: expect.stringContaining(`status pipeline success on CHG-0018's PR head ${head.slice(0, 7)}: noted`) } });
    const { sha: mergeSha } = await mergeOnGitLab(gl, 1, "eli-gl");
    const r = await h.deliver("Merge Request Hook", mrHook({ action: "merge", iid: 1, source: "CHG-0018/export-fix", headSha: head, mergeSha, user: "eli-gl" }), "u-merge");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ delivery: { changeId: "CHG-0018", outcome: "CHG-0018: gate 5 recorded from MR !1 merged by eli-gl" } });
    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(6);
    expect(view.pr?.mergeSha).toBe(mergeSha);
    expect(view.activity.find((a) => a.event === "pr.merged")).toMatchObject({ actor: "human", actorId: ENG.id });
    expect((await git(dir, ["show", "-s", "--format=%an <%ae>", "HEAD"])).trim()).toBe("Eli Ng <eng@veri.example>");
    expect(await isAncestor(dir, mergeSha, "main")).toBe(true);
    const commits = Number((await git(dir, ["rev-list", "--count", "HEAD"])).trim());
    expect((await h.deliver("Merge Request Hook", mrHook({ action: "merge", iid: 1, source: "CHG-0018/export-fix", headSha: head, mergeSha, user: "eli-gl" }), "u-merge")).body).toMatchObject({ replay: true });
    const resent = await h.deliver("Merge Request Hook", mrHook({ action: "merge", iid: 1, source: "CHG-0018/export-fix", headSha: head, mergeSha, user: "eli-gl" }), "u-merge-2");
    expect(resent.body).toMatchObject({ replay: false, delivery: { outcome: "CHG-0018: MR !1 merge already recorded" } });
    expect(Number((await git(dir, ["rev-list", "--count", "HEAD"])).trim())).toBe(commits);
    const unknown = await h.deliver("Merge Request Hook", mrHook({ action: "merge", iid: 42, source: "feature/x", headSha: "c".repeat(40), mergeSha: "d".repeat(40) }));
    expect(unknown.body).toMatchObject({ delivery: { outcome: "MR !42 merged: not a recorded merge request", changeId: null } });
    const push = await h.deliver("Push Hook", { ...PROJECT, object_kind: "push", ref: "refs/heads/main", before: "0".repeat(40), after: mergeSha }, "u-main");
    expect(push.body).toMatchObject({ delivery: { outcome: `origin/main moved to ${mergeSha.slice(0, 7)}: synced (0 merge(s) recorded)` } });
  }, 60_000);

  it("over HTTP: POST /api/webhooks/gitlab verifies X-Gitlab-Token; GET /api/webhooks reports the GitLab receiver", async () => {
    const { dir, env } = await gitlabSeed();
    const h = harness(dir, env);
    await h.store.refresh();
    const app = createApp(h.store, { registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", engine: h.engine, jobs: h.jobs, deliveries: h.deliveries, env });
    cleanups.push(() => app.close());
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const body = JSON.stringify({ ...PROJECT, object_kind: "push", ref: "refs/heads/feature/x", before: "a".repeat(40), after: "b".repeat(40) });
    const bad = await fetch(`${url}/api/webhooks/gitlab`, { method: "POST", headers: { "content-type": "application/json", "x-gitlab-event": "Push Hook", "x-gitlab-event-uuid": "h-1", "x-gitlab-token": "nope" }, body });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${url}/api/webhooks/gitlab`, { method: "POST", headers: { "content-type": "application/json", "x-gitlab-event": "Push Hook", "x-gitlab-event-uuid": "h-1", "x-gitlab-token": SECRET }, body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, replay: false, delivery: { id: "h-1", outcome: "push to feature/x: not a branch the console tracks" } });
    const status = (await (await fetch(`${url}/api/webhooks`)).json()) as { gitlab: { path: string; enabled: boolean; secretSet: boolean }; deliveries: { id: string }[] };
    expect(status.gitlab).toEqual({ path: "/api/webhooks/gitlab", enabled: true, secretSet: true });
    expect(status.deliveries).toEqual([expect.objectContaining({ id: "h-1" })]);
  });
});

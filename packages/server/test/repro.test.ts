import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { writeReproDraft } from "@sdlc/mcp";
import { ActionError, Engine, JobStore, SessionRegistry, StateStore, acceptGate, launchSession, reproDraftFor, startServer, type Exec, type Snapshot, type StoredSession } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const TEST = "test/export/zero-total.test.ts";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The seed with CHG-0018 (a fix) back before its repro was reported; optionally without managed hooks. */
async function seededFix(hooks = true): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-repro-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const changeYaml = join(dir, "sdlc/changes/CHG-0018/change.yaml");
  writeFileSync(changeYaml, readFileSync(changeYaml, "utf8").replace(/repro:\n(?: {2}.*\n)+/, "repro: null\n"));
  rmSync(join(dir, "sdlc/changes/CHG-0018/evals/repro.json"));
  rmSync(join(dir, "sdlc/changes/CHG-0018/evals/run-1.json"));
  if (!hooks) rmSync(join(dir, ".claude/settings.json"));
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed (repro not yet reported)"]);
  return dir;
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return { repo, view: deriveChange(repo, files) };
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 46 passed (46)" : `${cmd}: ok` });
const baseEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };

/** What the agent does through report_repro: the test alone in one commit, repro.failed on the branch ledger, the draft beside the session. */
async function agentReportsRepro(session: StoredSession, body: string, reason: string, output: string): Promise<string> {
  const wt = session.worktreePath;
  mkdirSync(join(wt, "test/export"), { recursive: true });
  writeFileSync(join(wt, TEST), body);
  await git(wt, ["add", "--", TEST]);
  await git(wt, ["commit", "-q", "-m", `sdlc(CHG-0018): repro test ${TEST}`, "--", TEST]);
  const sha = (await git(wt, ["rev-parse", "HEAD"])).trim();
  writeReproDraft(wt, session.id, { testPath: TEST, failureReason: reason, sha, output, ts: "2026-09-04T09:05:00Z" });
  return sha;
}

async function post(url: string, path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${url}/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function lastCommit(dir: string): Promise<string[]> {
  return (await git(dir, ["log", "-1", "--format=%s%n%an <%ae>%n%(trailers:key=SDLC-Actor,valueonly)"])).trim().split("\n");
}

describe("repro-first fix flow (2.7, spec 5B.3 / FR-51)", () => {
  it("report → hold (no run) → wrong failure, send back → report again → confirm (verified commit, proof verbatim, freeze) → lift once → fix with a stray test edit and no hooks → PR with the repro check and a test-freeze auto-finding → merge refused → dismiss with reason → merged", async () => {
    const dir = await seededFix(false);
    const server = await startServer({ cwd: dir, identity: ENG, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, watch: false });
    cleanups.push(() => server.close());
    const registry = server.registry;
    const jobs = new JobStore(registry.database);
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
    const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch: false, now: () => new Date("2026-09-04T09:00:00Z") });
    cleanups.push(() => engine.close());
    await store.refresh();
    const before = (await viewOf(dir, "CHG-0018")).view;
    expect(before.kind).toBe("fix");
    expect(before.stage).toBe(4);
    expect(before.repro).toBeNull();

    // the build session is prepared (SUPERVISED) and its prompt says repro first
    const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, env: baseEnv });
    const session = launched.session;
    expect(readFileSync(join(session.worktreePath, ".sdlc-state/sessions", session.id, "prompt.md"), "utf8")).toContain("Repro first (this is a fix)");
    const sha1 = await agentReportsRepro(session, "it('exports zero rows', () => { expect(rows).toHaveLength(3); });\n", "expected 3 rows, received 4", "AssertionError: expected 3 rows, received 4");
    registry.patch(session.id, { status: "done" });

    // the engine holds: a red run now would resume the agent into fixing before the engineer decided
    await engine.onSessionExit({ ...session, status: "done" });
    expect(jobs.list().filter((j) => j.kind === "per-change-run")).toEqual([]);
    server.store.rebuild();
    const snap1 = (await (await fetch(`${server.url}/api/state`)).json()) as Snapshot;
    const card = snap1.sessions.find((s) => s.id === session.id) as StoredSession | undefined;
    expect(card?.repro).toMatchObject({ testPath: TEST, sha: sha1, failureReason: "expected 3 rows, received 4" });
    expect(card?.waitingOnYou).toEqual({ reason: "confirm the repro test — fails for the right reason?" });
    expect(reproDraftFor(registry, "CHG-0018")?.draft.sha).toBe(sha1);

    // wrong failure — send back (engineer): on the ledger, on the draft, in the view
    const rejected = await post(server.url, "/changes/CHG-0018/repro/reject", { reason: "asserts the wrong count — the bug drops the zero-total row, expect 4" });
    expect(rejected.status).toBe(200);
    expect(await lastCommit(dir)).toEqual([`sdlc(CHG-0018): repro test ${TEST} sent back — asserts the wrong count — the bug drops the zero-total row, expect 4`, "Eli Ng <eng@veri.example>", "human:eng@veri.example"]);
    const v2 = (await viewOf(dir, "CHG-0018")).view;
    expect(v2.reproRejection).toMatchObject({ testPath: TEST, reason: "asserts the wrong count — the bug drops the zero-total row, expect 4" });
    expect(v2.activity[0]?.text).toBe(`sent back repro test ${TEST}: asserts the wrong count — the bug drops the zero-total row, expect 4`);
    expect(reproDraftFor(registry, "CHG-0018")?.draft.rejected?.reason).toContain("asserts the wrong count");
    // the resumed session's prompt carries the verdict (a resume relaunches; the fake harness exits at once)
    const resumed = registry.get(session.id);
    expect(resumed?.resumeCount).toBe(1);
    expect(readFileSync(join(session.worktreePath, ".sdlc-state/sessions", session.id, "prompt.md"), "utf8")).toContain("wrong failure: asserts the wrong count");
    await new Promise((r) => setTimeout(r, 800));

    // the session reports again; the engineer confirms — the commit is verified by sha, the proof is verbatim, the freeze begins
    const sha2 = await agentReportsRepro(session, "it('exports zero rows', () => { expect(rows).toHaveLength(4); });\n", "expected 4 rows, received 3", "AssertionError: expected 4 rows, received 3\n  at test/export/zero-total.test.ts:1:52");
    registry.patch(session.id, { status: "done" });
    const forged = await post(server.url, "/changes/CHG-0018/repro/confirm", { testPath: TEST, failureReason: "x", sha: "0".repeat(40) });
    expect(forged.status).toBe(409);
    expect(String(forged.body["error"])).toContain("is not in this repository");
    const confirmed = await post(server.url, "/changes/CHG-0018/repro/confirm", {});
    expect(confirmed.status).toBe(200);
    expect(String(confirmed.body["toast"])).toContain("freeze active on CHG-0018");
    expect(String(confirmed.body["toast"])).toContain(`${session.id} resumed to fix`);
    const v3 = (await viewOf(dir, "CHG-0018")).view;
    expect(v3.repro).toEqual({ state: "committed", testPath: TEST, failureReason: "expected 4 rows, received 3", sha: sha2 });
    expect(v3.reproRejection).toBeNull();
    const proof = JSON.parse(readFileSync(join(dir, "sdlc/changes/CHG-0018/evals/repro.json"), "utf8")) as { sha: string; output: string; confirmedBy: string };
    expect(proof).toMatchObject({ sha: sha2, output: "AssertionError: expected 4 rows, received 3\n  at test/export/zero-total.test.ts:1:52", confirmedBy: ENG.id });
    expect(reproDraftFor(registry, "CHG-0018")).toBeNull();
    expect((await post(server.url, "/changes/CHG-0018/repro/confirm", {})).status).toBe(400); // nothing left to confirm
    expect(readFileSync(join(session.worktreePath, ".sdlc-state/sessions", session.id, "prompt.md"), "utf8")).toContain("The test freeze is active");
    await new Promise((r) => setTimeout(r, 800));

    // freeze lift: once per file
    const lift = await post(server.url, "/changes/CHG-0018/freeze/lift", { path: "test/export/fixtures.ts", reason: "the fixture needs a zero-total invoice" });
    expect(lift.status).toBe(200);
    expect((await lastCommit(dir))[0]).toBe("sdlc(CHG-0018): lift test freeze once for test/export/fixtures.ts");
    const again = await post(server.url, "/changes/CHG-0018/freeze/lift", { path: "test/export/fixtures.ts", reason: "again" });
    expect(again.status).toBe(409);
    expect(String(again.body["error"])).toContain("already lifted once");
    expect((await viewOf(dir, "CHG-0018")).view.freezeLifts.map((l) => l.path)).toEqual(["test/export/fixtures.ts"]);

    // the fix lands with a stray edit to another test file; no managed hooks in this repo → nothing could block it
    const wt = session.worktreePath;
    mkdirSync(join(wt, "src/export"), { recursive: true });
    writeFileSync(join(wt, "src/export/csv.ts"), "export const rows = (xs: { total: number }[]) => xs;\n");
    writeFileSync(join(wt, "test/export/csv.test.ts"), "it('still exports', () => {});\n");
    writeFileSync(join(wt, "test/export/fixtures.ts"), "export const zero = { total: 0 };\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
    const run = await engine.runForSession({ ...(registry.get(session.id) ?? session), status: "done" });
    expect(run?.state).toBe("done");
    expect(run?.note).toContain("green · PR opened");
    const v4 = (await viewOf(dir, "CHG-0018")).view;
    expect(v4.stage).toBe(5);
    expect(v4.pr?.checks).toEqual([
      { name: "evidence", verdict: "pass", summary: expect.stringContaining("verification commands passed") as string },
      { name: "evals", verdict: "pass", summary: expect.any(String) as string },
      { name: "repro", verdict: "pass", summary: `repro test ${TEST} committed ${sha2.slice(0, 7)} before fix · unchanged in diff · passing now` },
      { name: "test-freeze", verdict: "fail", summary: `1 test file changed after the repro commit ${sha2.slice(0, 7)} with no managed hook to block it: test/export/csv.test.ts` },
    ]);
    expect(v4.pr?.autoFindings).toEqual([{ rule: "test-freeze", path: "test/export/csv.test.ts", title: "diff touches a test file during a fix", detail: `test/export/csv.test.ts changed after the repro commit ${sha2.slice(0, 7)} without a freeze lift; managed hooks are not installed, so the edit was not blocked` }]);

    // the console's merge waits on the finding; dismissing it with a reason is logged and unblocks it
    await store.refresh(true);
    const refused = await acceptGate(store, "CHG-0018", 5).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).message).toContain("diff touches a test file during a fix: test/export/csv.test.ts");
    expect((refused as ActionError).status).toBe(409);
    expect((await git(dir, ["branch", "--merged", "main"])).includes("CHG-0018/export-fix")).toBe(false); // refused before merging
    const dismissed = await post(server.url, "/changes/CHG-0018/auto-findings/dismiss", { path: "test/export/csv.test.ts", reason: "I edited the assertion myself — the old one asserted the bug" });
    expect(dismissed.status).toBe(200);
    expect((await lastCommit(dir))[0]).toBe("sdlc(CHG-0018): dismiss auto-finding on test/export/csv.test.ts — I edited the assertion myself — the old one asserted the bug");
    const v5 = (await viewOf(dir, "CHG-0018")).view;
    expect(v5.pr?.autoFindings?.[0]?.dismissal).toMatchObject({ by: ENG.id, reason: "I edited the assertion myself — the old one asserted the bug" });
    expect(v5.activity.find((a) => a.event === "note")?.text).toContain('dismissed auto-finding "diff touches a test file during a fix" on test/export/csv.test.ts');
    await store.refresh(true);
    const merged = await acceptGate(store, "CHG-0018", 5);
    expect(merged.toast).toBe("Merge PR — CHG-0018 moved to Maintain");
    expect((await viewOf(dir, "CHG-0018")).view.stage).toBe(6);
    cleanups.push(() => new Promise((r) => setTimeout(r, 300)));
  }, 60_000);

  it("with managed hooks installed no auto-finding is raised (the hook's decisions are on the ledger); a repro test modified after its commit makes the repro check red and the merge is refused", async () => {
    const dir = await seededFix(true);
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
    const jobs = new JobStore(registry.database);
    const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch: false, now: () => new Date("2026-09-04T09:00:00Z") });
    cleanups.push(() => engine.close());
    await store.refresh();
    const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, env: baseEnv });
    const session = launched.session;
    const sha = await agentReportsRepro(session, "it('exports zero rows', () => { expect(rows).toHaveLength(4); });\n", "expected 4 rows, received 3", "AssertionError");
    const server = await startServer({ cwd: dir, identity: ENG, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, watch: false });
    cleanups.push(() => server.close());
    // the server has its own registry over the same database file
    const confirmed = await post(server.url, "/changes/CHG-0018/repro/confirm", { testPath: TEST, failureReason: "expected 4 rows, received 3", sha, output: "AssertionError" });
    expect(confirmed.status).toBe(200);
    const wt = session.worktreePath;
    // the fix edits the repro test itself (hooks would have blocked an agent; a human did it) and another test file
    writeFileSync(join(wt, TEST), "it('exports zero rows', () => { expect(rows).toHaveLength(5); });\n");
    writeFileSync(join(wt, "test/export/csv.test.ts"), "it('still exports', () => {});\n");
    mkdirSync(join(wt, "src/export"), { recursive: true });
    writeFileSync(join(wt, "src/export/csv.ts"), "export const rows = 1;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): fix"]);
    const run = await engine.runForSession({ ...(registry.get(session.id) ?? session), status: "done" });
    expect(run?.state).toBe("done");
    const v = (await viewOf(dir, "CHG-0018")).view;
    expect(v.stage).toBe(5);
    expect(v.pr?.checks.map((c) => [c.name, c.verdict])).toEqual([["evidence", "pass"], ["evals", "pass"], ["repro", "fail"]]);
    expect(v.pr?.checks.find((c) => c.name === "repro")?.summary).toBe(`repro test ${TEST} committed ${sha.slice(0, 7)} before fix · modified after the repro commit without a lift · passing now`);
    expect(v.pr?.autoFindings).toBeUndefined();
    await store.refresh(true);
    const refused = await acceptGate(store, "CHG-0018", 5).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).message).toContain("the repro proof is fail");
    expect((refused as ActionError).diagnostics[0]?.rule).toBe("merge.repro-red");
    expect((await viewOf(dir, "CHG-0018")).view.stage).toBe(5);
  }, 60_000);
});

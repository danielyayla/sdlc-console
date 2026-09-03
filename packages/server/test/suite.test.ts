import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, evalGate, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { Engine, JobStore, SessionRegistry, StateStore, acceptGate, createApp, launchSession, runSuite, type Exec } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const NOW = () => new Date("2026-09-04T09:00:00Z");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(configPatch: (text: string) => string = (t) => t): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-suite-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, configPatch(readFileSync(cfg, "utf8")));
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: `${cmd}: Tests 12 passed (12)` });
const exportRed: Exec = (cmd) => Promise.resolve(cmd.includes("test/export") ? { exitCode: 1, output: "Tests 1 failed | 11 passed\n  ✗ zero-total row missing" } : { exitCode: 0, output: `${cmd}: Tests 12 passed (12)` });
/** A clock that advances one minute per reading. */
function minuteClock(): () => number {
  let t = 0;
  return () => (t += 60_000);
}

async function repoAt(dir: string) {
  return loadRepo(await readTree(dir, "HEAD"));
}

describe("eval suite run (2.5): active cases, verbatim output, run file by sdlc-bot", () => {
  it("runs every active case's checks in a detached worktree, records pass rate/threshold/verdict/cost and commits evals/runs/RUN-0002.json on the current branch", async () => {
    const dir = await seeded();
    const repo = await repoAt(dir);
    const clock = minuteClock();
    const r = await runSuite({ root: dir, repo, trigger: "manual", exec: green, now: NOW, clock, env: { SDLC_MODEL: "claude-fable-5-1" } });
    expect(r.skipped).toBeNull();
    expect(r.run).toMatchObject({ id: "RUN-0002", trigger: "manual", passRate: 1, threshold: 0.9, verdict: "pass", cost: 1, startedAt: "2026-09-04T09:00:00Z" });
    expect(r.run?.results.map((x) => x.caseId)).toEqual(["CASE-0001", "CASE-0002"]);
    expect(r.run?.results[0]?.output).toContain("--- test: pnpm test -- test/export (exit 0)\npnpm test -- test/export: Tests 12 passed (12)");
    expect(r.run?.configRef.model).toBe("claude-fable-5-1");
    expect(r.run?.configRef.claudeMdSha).toBe(repo.fingerprint.claudeMdSha);
    expect(r.signals).toEqual([]);
    const after = await repoAt(dir);
    expect(after.evalRuns.map((x) => x.id)).toEqual(["RUN-0001", "RUN-0002"]);
    expect((await git(dir, ["log", "-1", "--format=%s%n%an <%ae>%n%(trailers:key=SDLC-Actor,valueonly)"])).trim().split("\n")).toEqual(["sdlc(evals): suite run RUN-0002 pass (2/2 of 2)", "sdlc-bot <sdlc-bot@sdlc.local>", "system:sdlc-bot@sdlc.local"]);
    expect(existsSync(join(dir, ".sdlc-state", "worktrees"))).toBe(true);
    expect((await git(dir, ["worktree", "list"])).split("\n").filter((l) => l.includes("evals-"))).toEqual([]);
    expect(evalGate(after)).toMatchObject({ ok: true, run: { id: "RUN-0002" } });
  });

  it("stops at the budget → incomplete (never a pass, gate blocked); an exhausted budget refuses before running; scheduled mode skips the config-pr trigger", async () => {
    const dir = await seeded((t) => t.replace("threshold: 0.9", "threshold: 0.9\n  budget: 3"));
    // seed RUN-0001 cost 1.42 in the window; the clock adds a minute per reading, so the second case would cross 3
    const r = await runSuite({ root: dir, repo: await repoAt(dir), trigger: "manual", exec: green, now: NOW, clock: minuteClock() });
    expect(r.run).toMatchObject({ id: "RUN-0002", verdict: "incomplete", passRate: 1 });
    expect(r.run?.results).toHaveLength(1);
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe("sdlc(evals): suite run RUN-0002 incomplete (1/1 of 2 · stopped at the budget)");
    const after = await repoAt(dir);
    const gate = evalGate(after);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("incomplete never counts as pass");
    // the stopped run still cost its minutes: 1.42 + 3 ≥ 3, exhausted
    expect(r.run?.cost).toBe(3);
    await expect(runSuite({ root: dir, repo: after, trigger: "manual", exec: green, now: NOW, clock: minuteClock() })).rejects.toThrow(/budget exhausted: 4\.42 of 3/);
    expect((await repoAt(dir)).evalRuns).toHaveLength(2);

    const sched = await seeded((t) => t.replace("mode: continuous", "mode: scheduled\n  schedule: \"0 3 * * *\""));
    const skipped = await runSuite({ root: sched, repo: await repoAt(sched), trigger: "config-pr", exec: green, now: NOW, clock: minuteClock() });
    expect(skipped).toMatchObject({ skipped: "evals.mode is scheduled: config PRs are not gated", run: null, commit: null });
    expect((await repoAt(sched)).evalRuns).toHaveLength(1);
    const manual = await runSuite({ root: sched, repo: await repoAt(sched), trigger: "schedule", exec: green, now: NOW, clock: minuteClock() });
    expect(manual.run?.trigger).toBe("schedule");
    expect(evalGate(await repoAt(sched))).toMatchObject({ ok: true, gated: false });
  });

  it("raises retire and broken-check triage items once per streak, committed by sdlc-bot after the run", async () => {
    const dir = await seeded((t) => t.replace("suiteMinSize: 20", "suiteMinSize: 20\n  noDiscriminationRuns: 2\n  brokenCheckRuns: 2"));
    const first = await runSuite({ root: dir, repo: await repoAt(dir), trigger: "schedule", exec: green, now: NOW, clock: minuteClock() });
    expect(first.signals.map((s) => [s.kind, s.caseId])).toEqual([["retire", "CASE-0001"], ["retire", "CASE-0002"]]);
    expect(first.signalsCommit).not.toBeNull();
    const after1 = await repoAt(dir);
    expect(after1.triage.filter((t) => t.data.tier === "eval-retire").map((t) => [t.data.id, t.data.src])).toEqual([["TRI-0044", "eval-retire:CASE-0001"], ["TRI-0045", "eval-retire:CASE-0002"]]);
    expect((await git(dir, ["log", "-1", "--format=%s%n%an"])).trim().split("\n")).toEqual(["sdlc(evals): 2 triage items from the suite (retire CASE-0001, retire CASE-0002)", "sdlc-bot"]);
    expect(after1.triage.find((t) => t.data.id === "TRI-0044")?.body).toContain("## Proposed outcome");
    // the streak extends: nothing new
    const second = await runSuite({ root: dir, repo: after1, trigger: "schedule", exec: green, now: NOW, clock: minuteClock() });
    expect(second.signals).toEqual([]);
    expect((await repoAt(dir)).triage).toHaveLength(4);
    // CASE-0001 fails twice under the same config → broken check
    const third = await runSuite({ root: dir, repo: await repoAt(dir), trigger: "schedule", exec: exportRed, now: NOW, clock: minuteClock() });
    expect(third.run?.verdict).toBe("fail");
    expect(third.signals).toEqual([]);
    const fourth = await runSuite({ root: dir, repo: await repoAt(dir), trigger: "schedule", exec: exportRed, now: NOW, clock: minuteClock() });
    expect(fourth.signals.map((s) => [s.kind, s.caseId, s.src])).toEqual([["broken", "CASE-0001", "eval-broken:CASE-0001"]]);
    const flaky = (await repoAt(dir)).triage.find((t) => t.data.id === "TRI-0046");
    expect(flaky?.data).toMatchObject({ tier: "flaky", status: "open", title: "CASE-0001: broken check (failing 2 runs, no config change)" });
    expect(flaky?.data.evidence).toContain("zero-total row missing");
  });
});

function harness(dir: string) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch: false, now: NOW });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("engine job, console endpoints and harvest (2.5)", () => {
  it("POST /api/evals/run queues a keyed job that commits the run; GET /api/evals carries the banner; Add as eval drafts a case once per merged change", async () => {
    const dir = await seeded();
    const h = harness(dir);
    await h.store.refresh();
    const app = createApp(h.store, { registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", engine: h.engine, jobs: h.jobs });
    cleanups.push(() => app.close());
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const queued = (await (await fetch(`${url}/api/evals/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { ok: boolean; job: { key: string; state: string }; toast: string };
    expect(queued.job.key).toBe("evals:manual:RUN-0002");
    expect(queued.toast).toContain("suite run queued (RUN-0002)");
    await waitFor(() => h.jobs.get("evals:manual:RUN-0002")?.state === "done");
    expect(h.jobs.get("evals:manual:RUN-0002")?.note).toBe("RUN-0002 pass · 100% (2/2)");
    const status = (await (await fetch(`${url}/api/evals`)).json()) as { latest: { id: string }; gate: { ok: boolean }; budget: { used: number } };
    expect(status).toMatchObject({ latest: { id: "RUN-0002" }, gate: { ok: true } });
    expect(status.budget.used).toBeGreaterThanOrEqual(1.42);
    // a second click while nothing changed: the key is the next run id, so it runs again (a new run is what was asked for)
    const again = await h.engine.runSuite("manual");
    expect(again.job?.key).toBe("evals:manual:RUN-0003");
    expect(again.outcome?.run?.id).toBe("RUN-0003");
    expect((await fetch(`${url}/api/evals/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trigger: "nightly" }) })).status).toBe(400);

    // CHG-0012 (Maintain) was harvested by the seed; CHG-0018 is not merged yet
    const dup = await fetch(`${url}/api/changes/CHG-0012/harvest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toContain("already harvested as CASE-0002");
    const early = await fetch(`${url}/api/changes/CHG-0018/harvest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(early.status).toBe(409);
    // build → run → PR → merge, then harvest
    const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
    const wt = launched.session.worktreePath;
    mkdirSync(join(wt, "src/export"), { recursive: true });
    writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
    h.registry.patch(launched.session.id, { status: "done" });
    expect((await h.engine.runForSession({ ...launched.session, status: "done" }))?.state).toBe("done");
    await acceptGate(h.store, "CHG-0018", 5);
    const merged = deriveChange(await repoAt(dir), (await repoAt(dir)).changes.get("CHG-0018") ?? (() => { throw new Error("CHG-0018"); })());
    expect(merged.stage).toBe(6);
    expect(merged.harvested).toBeNull();
    const harvested = (await (await fetch(`${url}/api/changes/CHG-0018/harvest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { ok: boolean; toast: string };
    expect(harvested.toast).toContain("CASE-0004 drafted from CHG-0018");
    const after = await repoAt(dir);
    const c = after.evalCases.find((x) => x.id === "CASE-0004");
    expect(c).toMatchObject({ status: "draft", owner: "platform@veri.example", source: { type: "change", ref: "CHG-0018" }, checks: [{ name: "build", cmd: "pnpm build" }, { name: "test", cmd: "pnpm test" }, { name: "lint", cmd: "pnpm lint" }] });
    expect(c?.paths).toEqual(merged.planFiles);
    const view = deriveChange(after, after.changes.get("CHG-0018") ?? (() => { throw new Error("CHG-0018"); })());
    expect(view.harvested).toEqual({ id: "CASE-0004", status: "draft" });
    expect(view.activity.find((a) => a.event === "note")?.text).toContain("harvested as CASE-0004");
    expect((await git(dir, ["log", "-1", "--format=%s %an"])).trim()).toBe("sdlc(CHG-0018): harvest CASE-0004 (draft) Eli Ng");
    // the draft never enters the suite
    const next = await runSuite({ root: dir, repo: after, trigger: "manual", exec: green, now: NOW, clock: minuteClock() });
    expect(next.run?.results.map((r) => r.caseId)).toEqual(["CASE-0001", "CASE-0002"]);
  }, 60_000);
});

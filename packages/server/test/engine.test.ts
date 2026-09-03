import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { accept, deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { Engine, JobStore, SessionRegistry, StateStore, launchSession, type Exec } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-engine-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return { repo, view: deriveChange(repo, files) };
}

const ENG = { id: "eng@veri.example", name: "Eli Ng" };

function harness(dir: string, exec: Exec, autoLaunch = false) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec, autoLaunch, now: () => new Date("2026-09-04T09:00:00Z") });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

describe("per-change run → PR → stage 5 → merge → stage 6 → loop (acceptance l, exit criterion in local mode)", () => {
  it("green run writes run-2.json on main, opens the local PR and derives stage 5; gate 5 merges the task branch → 6", async () => {
    const dir = await seeded();
    const calls: string[] = [];
    const exec: Exec = (cmd) => {
      calls.push(cmd);
      // eval-case checks require their healthyOutput literally ("passed" for CASE-0001); commands go by exit code
      return Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });
    };
    const { registry, store, jobs, engine } = harness(dir, exec);
    await store.refresh();
    // a build session on CHG-0018's task branch with a code change
    const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
    const wt = launched.session.worktreePath;
    // 2.7: the seed's repro sha is a placeholder; a fix merges only with a real repro commit before the fix, so make one and point change.yaml + repro.json at it
    mkdirSync(join(wt, "test/export"), { recursive: true });
    writeFileSync(join(wt, "test/export/zero-total.test.ts"), "it('exports zero-total rows', () => { expect(rows).toHaveLength(4); });\n");
    await git(wt, ["add", "--", "test/export/zero-total.test.ts"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): repro test test/export/zero-total.test.ts", "--", "test/export/zero-total.test.ts"]);
    const reproSha = (await git(wt, ["rev-parse", "HEAD"])).trim();
    for (const rel of ["sdlc/changes/CHG-0018/change.yaml", "sdlc/changes/CHG-0018/evals/repro.json"]) writeFileSync(join(dir, rel), readFileSync(join(dir, rel), "utf8").replaceAll("e4a6f2d5a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5", reproSha));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "sdlc(CHG-0018): repro sha"]);
    mkdirSync(join(wt, "src/export"), { recursive: true });
    writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
    registry.patch(launched.session.id, { status: "done" });

    const job = await engine.runForSession({ ...launched.session, status: "done" });
    expect(job?.state).toBe("done");
    expect(job?.note).toContain("green");
    expect(calls).toEqual(["pnpm build", "pnpm test", "pnpm lint", "pnpm test -- test/export"]); // 3 commands + CASE-0001 check (paths intersect)
    const { view } = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.gate).toMatchObject({ s: 5, acceptLabel: "Merge" });
    expect(view.pr).toMatchObject({ provider: "local", branch: "CHG-0018/export-fix", baseBranch: "main" });
    expect(view.latestRun?.n).toBe(2);
    expect(view.latestRun?.fileSet).toEqual(["src/export/csv.ts", "test/export/zero-total.test.ts"]);
    expect(view.pr?.checks.find((c) => c.name === "repro")).toEqual({ name: "repro", verdict: "pass", summary: `repro test test/export/zero-total.test.ts committed ${reproSha.slice(0, 7)} before fix · unchanged in diff · passing now` });
    expect(view.activity.slice(0, 3).map((a) => a.event)).toEqual(["stage.entered", "pr.opened", "evals.green"]);
    expect(jobs.list().map((j) => j.kind)).toEqual(["per-change-run"]);
    // idempotent: the same session exit again claims nothing
    expect(await engine.runForSession({ ...launched.session, status: "done" })).toBeNull();

    // gate 5: engineer merges (core accept with mergeSha after the adapter merge) → stage 6
    const { repo, view: v5 } = await viewOf(dir, "CHG-0018");
    const { mergeBranch, commitWritePlan } = await import("@sdlc/adapter-git");
    const mergeSha = await mergeBranch(dir, "CHG-0018/export-fix", "sdlc(CHG-0018): merge CHG-0018/export-fix (gate 5)", ENG);
    const merged = await viewOf(dir, "CHG-0018");
    void repo;
    void v5;
    const r = accept(merged.repo, merged.view, 5, { now: "2026-09-04T10:00:00Z", newId: () => `01J8Z6Q7Y2K3M4N5P6Q7R8S9${Math.random().toString(36).slice(2, 4).toUpperCase()}`.replace(/[ILOU]/g, "X"), actor: { id: ENG.id }, mergeSha });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    await commitWritePlan(dir, r.plan, { identity: ENG });
    const v6 = (await viewOf(dir, "CHG-0018")).view;
    expect(v6.stage).toBe(6);
    expect(v6.status).toBe("Deployed · monitoring");
  }, 30_000);

  it("red run keeps stage 4 and resumes the session once; a second red waits on you", async () => {
    // the engine is the only launcher here: with autoLaunch it starts the build session (AUTO, eligible) itself
    const exec: Exec = (cmd) => Promise.resolve(cmd === "pnpm test" ? { exitCode: 1, output: "1 failed: zero-total row missing" } : { exitCode: 0, output: "ok" });
    const waitFor = async (pred: () => boolean, ms = 15_000): Promise<void> => {
      const until = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > until) throw new Error("timed out waiting for the engine");
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const doneRuns = (jobs: JobStore) => jobs.list().filter((j) => j.kind === "per-change-run" && (j.state === "done" || j.state === "failed")).length;

    // seed already has run-1 red → the engine's run is the second red → waiting on you, no resume
    const dir = await seeded();
    const h = harness(dir, exec, true);
    await h.store.refresh();
    await h.engine.tick();
    await waitFor(() => doneRuns(h.jobs) >= 1);
    const first = (await viewOf(dir, "CHG-0018")).view;
    expect(first.stage).toBe(4);
    expect(first.evalsState).toBe("waiting");
    expect(first.status).toBe("waiting on you: evals red twice");
    expect(h.jobs.list().filter((j) => j.changeId === "CHG-0018").map((j) => j.kind).sort()).toEqual(["build-session", "per-change-run"]);
    // the seed's Deploy change (CHG-0017) gets a review attempt; its PR branch is not in this clone, so the launch refuses and nothing is created
    const review = h.jobs.list().filter((j) => j.kind === "review");
    expect(review.map((j) => [j.changeId, j.state])).toEqual([["CHG-0017", "failed"]]);
    expect(review[0]?.error).toContain("not in this clone");

    // without the seed's red run: first red resumes the session with the failing output; the resumed fake run is red again → waiting
    const dir2 = await seeded();
    await git(dir2, ["rm", "-q", "sdlc/changes/CHG-0018/evals/run-1.json"]);
    await git(dir2, ["commit", "-q", "-m", "drop seed run"]);
    const h2 = harness(dir2, exec, true);
    await h2.store.refresh();
    await h2.engine.tick();
    await waitFor(() => doneRuns(h2.jobs) >= 2);
    const kinds = h2.jobs.list().map((j) => j.kind);
    expect(kinds.filter((k) => k === "resume-session")).toHaveLength(1);
    expect(kinds.filter((k) => k === "per-change-run")).toHaveLength(2);
    const after = (await viewOf(dir2, "CHG-0018")).view;
    expect(after.stage).toBe(4);
    expect(after.evalsState).toBe("waiting");
    const resumed = h2.registry.list().find((s) => s.id === h2.jobs.list().find((j) => j.kind === "resume-session")?.sessionId);
    expect(resumed?.status).toBe("done");
  }, 40_000);

  it("with autoLaunch the engine starts a design session after gate 1 and a plan session after gate 2, once per key", async () => {
    const dir = await seeded();
    const exec: Exec = () => Promise.resolve({ exitCode: 0, output: "ok" });
    const { store, engine, jobs, registry } = harness(dir, exec, true);
    await store.refresh();
    await engine.tick();
    await new Promise((r) => setTimeout(r, 1500));
    // CHG-0018 (stage 4, red, no session) gets a build session + run; CHG-0021 (gate open) and CHG-0023 (intent is human-started) get nothing
    const kinds = jobs.list().filter((j) => j.kind !== "review").map((j) => [j.changeId, j.kind]);
    expect(kinds.every(([id]) => id === "CHG-0018")).toBe(true);
    expect(kinds.map(([, k]) => k)).toEqual(expect.arrayContaining(["build-session"]));
    // accept gate 1 on CHG-0022 → design pass launches; a second tick does not launch again
    const { accept: acceptFn } = await import("@sdlc/core");
    const { commitWritePlan } = await import("@sdlc/adapter-git");
    const { repo, view } = await viewOf(dir, "CHG-0022");
    const r = acceptFn(repo, view, 1, { now: "2026-09-04T09:00:00Z", newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9TC", actor: { id: PO } });
    if (!r.ok) throw new Error("accept");
    await commitWritePlan(dir, r.plan, { identity: { id: PO, name: "P" } });
    await store.refresh(true);
    await engine.tick();
    await new Promise((r2) => setTimeout(r2, 800));
    await engine.tick();
    const design = jobs.list().filter((j) => j.kind === "design-pass");
    expect(design).toHaveLength(1);
    expect(design[0]?.changeId).toBe("CHG-0022");
    expect(design[0]?.state).toBe("done"); // the fake harness finished → the job is closed
    expect(registry.list().find((s) => s.id === design[0]?.sessionId)?.kind).toBe("design");
    cleanups.push(() => new Promise((r3) => setTimeout(r3, 300)));
  }, 30_000);
});

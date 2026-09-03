import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { Engine, JobStore, SessionRegistry, StateStore, capacityOf, launchSession, startServer, worktreePathFor, type Exec, type Snapshot, type StoredSession } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-depth-"));
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

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: `${cmd}: ok` });
const baseEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };

/** A finished session in the registry (runtime cache), never committed anywhere. */
function doneSession(dir: string, i: number, kind: "design" | "build", changeId: string, reviewed = false): StoredSession {
  const branch = kind === "design" ? `sdlc/${changeId}/spec` : `${changeId}/work-${i}`;
  return { id: `sess-done-${i}`, kind, cycle: 1, resumeCount: 0, worktree: branch, worktreePath: worktreePathFor(dir, branch), branch, changeId, taskId: null, mode: "HEADLESS", engineer: ENG.id, startedAt: `2026-09-04T0${i}:00:00Z`, heartbeatAt: `2026-09-04T0${i}:10:00Z`, status: "done", target: null, files: [], subagents: [], loop: { state: "not-run", rounds: [] }, verifier: null, testEditAttempts: 0, waitingOnYou: null, autoRationale: { terms: [] }, modelPin: null, contextManifestRef: null, transcriptRef: null, harnessSessionId: "", pid: null, exitCode: 0, command: "", capRaised: false, reviewed, costUsd: null, numTurns: null, lastLine: null, error: null };
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("capacity ceiling (2.6, FR-35)", () => {
  it("backlog = sessions done and awaiting review; over the ceiling the launcher refuses, the engine holds the build session and launches it once the backlog clears; null = no ceiling", async () => {
    const dir = await seeded();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
    const jobs = new JobStore(registry.database);
    const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch: true, now: () => new Date("2026-09-04T09:00:00Z") });
    cleanups.push(() => engine.close());
    await store.refresh();
    // the seed ceiling is 4: five finished design sessions on CHG-0021 (still at stage 2 → their spec awaits gate 2) are over it
    for (let i = 1; i <= 5; i++) registry.upsert(doneSession(dir, i, "design", "CHG-0021"));
    store.rebuild();
    expect(store.current?.capacity).toEqual({ active: 0, backlog: 5, ceiling: 4, over: true });
    await expect(launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, env: baseEnv })).rejects.toThrow(/review backlog 5 exceeds the ceiling 4/);
    const lines: string[] = [];
    const held = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch: true, log: (l) => lines.push(l), now: () => new Date("2026-09-04T09:00:00Z") });
    cleanups.push(() => held.close());
    engine.close();
    await held.tick();
    await new Promise((r) => setTimeout(r, 300));
    // nothing claimed for CHG-0018's build: the hold is not a failed job, it is no job
    expect(jobs.list().filter((j) => j.changeId === "CHG-0018" && j.kind === "build-session")).toEqual([]);
    expect(lines.some((l) => l.includes("CHG-0018: build session held — review backlog 5 over the ceiling 4"))).toBe(true);
    await held.tick();
    expect(lines.filter((l) => l.includes("build session held")).length).toBe(1); // logged once per hold

    // reviewing the sessions clears the backlog: the next tick launches the build session (AUTO — CHG-0018 is eligible)
    for (let i = 1; i <= 5; i++) registry.patch(`sess-done-${i}`, { reviewed: true });
    store.rebuild();
    expect(store.current?.capacity).toEqual({ active: 0, backlog: 0, ceiling: 4, over: false });
    await held.tick();
    // the job is claimed before the launch finishes: wait for the session id (or a failure) to land on it
    await waitFor(() => jobs.list().some((j) => j.changeId === "CHG-0018" && j.kind === "build-session" && (j.sessionId !== null || j.state === "failed")));
    const job = jobs.list().find((j) => j.changeId === "CHG-0018" && j.kind === "build-session");
    expect(job?.error ?? null).toBeNull();
    expect(job?.state === "running" || job?.state === "done").toBe(true);
    const launched = registry.get(job?.sessionId ?? "");
    expect(launched?.mode).toBe("AUTO");

    // a design session whose gate was decided no longer awaits review; a build session counts until a green run covers it
    const { repo } = await viewOf(dir, "CHG-0018");
    const mixed = [
      ...[1, 2, 3, 4, 5].map((i) => doneSession(dir, i, "design", "CHG-0021")),
      doneSession(dir, 6, "design", "CHG-0019"), // CHG-0019 is at stage 3: its spec was accepted, nothing left to review
      doneSession(dir, 7, "build", "CHG-0018"), // no green run covered it yet
      doneSession(dir, 8, "build", "CHG-0018", true), // covered
      { ...doneSession(dir, 9, "build", "CHG-0012"), status: "done" as const }, // CHG-0012 is merged (stage 6)
    ];
    expect(capacityOf(mixed, repo)).toEqual({ active: 0, backlog: 6, ceiling: 4, over: true });
    // sessionCeiling: null → no ceiling, counts only
    const unlimited = { ...repo, config: { ...repo.config, thresholds: { ...repo.config.thresholds, sessionCeiling: null } } };
    expect(capacityOf(mixed, unlimited)).toEqual({ active: 0, backlog: 6, ceiling: null, over: false });
    cleanups.push(() => new Promise((r) => setTimeout(r, 500)));
  }, 30_000);
});

describe("AUTO → SUPERVISED override (2.6, FR-22/FR-34)", () => {
  it("records override.mode by the engineer on the ledger, ends the harness, parks the session as awaiting the engineer with a resume command; never upward, never twice", async () => {
    const dir = await seeded();
    const server = await startServer({ cwd: dir, identity: ENG, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, watch: false });
    cleanups.push(() => server.close());
    const registry = server.registry;
    const r = await launchSession({ changeId: "CHG-0018", mode: "AUTO" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, env: { ...baseEnv, FAKE_CLAUDE_SLEEP: "30" } });
    expect(r.session.status).toBe("running");
    expect(r.session.pid).not.toBeNull();
    server.store.rebuild();
    const before = (await (await fetch(`${server.url}/api/state`)).json()) as Snapshot;
    expect(before.capacity).toEqual({ active: 1, backlog: 0, ceiling: 4, over: false });

    const nope = await fetch(`${server.url}/api/sessions/nope/downgrade`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(nope.status).toBe(404);
    const res = await fetch(`${server.url}/api/sessions/${r.session.id}/downgrade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "needs eyes on the filter" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: StoredSession; commit: string; toast: string };
    expect(body.toast).toBe(`${r.session.id} downgraded to SUPERVISED — run the command from the card`);
    expect(body.session).toMatchObject({ mode: "SUPERVISED", status: "awaiting_engineer", waitingOnYou: { reason: "downgraded — continue the session in your terminal" } });
    // the resume targets the harness's own session id (from its init line), not the one the launcher proposed
    expect(body.session.command).toContain("--resume 11111111-2222-3333-4444-555555555555");
    expect(body.session.command).toContain("--permission-mode acceptEdits");
    expect(body.session.command).toContain(`cd ${r.session.worktreePath}`);
    // the harness was ended; the record keeps the parked status
    const code = await r.finished;
    expect(code === null || code !== 0).toBe(true);
    expect(registry.get(r.session.id)).toMatchObject({ mode: "SUPERVISED", status: "awaiting_engineer", pid: null });
    // the ledger on main carries the engineer's decision
    const log = (await git(dir, ["log", "-1", "--format=%s%n%an <%ae>%n%(trailers:key=SDLC-Actor,valueonly)"])).trim().split("\n");
    expect(log[0]).toBe(`sdlc(CHG-0018): session ${r.session.id} AUTO → SUPERVISED (needs eyes on the filter)`);
    expect(log[1]).toBe("Eli Ng <eng@veri.example>");
    expect(log[2]).toBe("human:eng@veri.example");
    const { view } = await viewOf(dir, "CHG-0018");
    const line = view.activity.find((a) => a.event === "override.mode");
    expect(line?.text).toBe("mode AUTO → SUPERVISED: needs eyes on the filter");
    expect(line?.actor).toBe("human");
    expect(view.valid).toBe(true);
    // the task branch records the harness end as a takeover
    const branchRepo = loadRepo(await readTree(r.session.worktreePath, "HEAD"));
    const stopped = branchRepo.changes.get("CHG-0018")?.events.find((e) => e.event === "session.stopped" && e.data.session === r.session.id);
    expect(stopped?.data).toEqual({ session: r.session.id, reason: "taken_over" });
    // a SUPERVISED session cannot be downgraded again, and nothing goes upward
    const again = await fetch(`${server.url}/api/sessions/${r.session.id}/downgrade`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("only AUTO or HEADLESS sessions can be downgraded");
  }, 30_000);
});

describe("visual rounds: mock and screenshot routes (2.6, FR-33)", () => {
  it("serves the change's design mock from git and a round's screenshot from the worktree, nothing else", async () => {
    const dir = await seeded();
    const server = await startServer({ cwd: dir, identity: ENG, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, watch: false });
    cleanups.push(() => server.close());
    const { view } = await viewOf(dir, "CHG-0018");
    expect(view.visual).toEqual({ uiPaths: [], tool: null, mock: { path: "sdlc/changes/CHG-0018/design/export-dialog.svg", sha: expect.stringMatching(/^[0-9a-f]{40}$/) as string }, warning: null });
    const mock = await fetch(`${server.url}/api/changes/CHG-0018/design/export-dialog.svg`);
    expect(mock.status).toBe(200);
    expect(mock.headers.get("content-type")).toBe("image/svg+xml");
    expect(await mock.text()).toContain("Download CSV");
    expect((await fetch(`${server.url}/api/changes/CHG-0018/design/nope.svg`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/changes/CHG-0019/design/export-dialog.svg`)).status).toBe(404);

    const s = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: server.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, env: baseEnv });
    const stateDir = join(s.session.worktreePath, ".sdlc-state", "sessions", s.session.id);
    mkdirSync(join(stateDir, "screenshots"), { recursive: true });
    writeFileSync(join(stateDir, "screenshots", "round-1.png"), Buffer.from("PNG-bytes"));
    const round = (n: number, ref?: string) => JSON.stringify({ n, ts: "2026-09-04T09:00:00Z", results: [{ name: "test", pass: false, outputExcerpt: "1 failed" }], ...(ref ? { screenshotRef: ref } : {}), dirtyHash: "abc" });
    writeFileSync(join(stateDir, "rounds.jsonl"), `${round(1, `.sdlc-state/sessions/${s.session.id}/screenshots/round-1.png`)}\n${round(2)}\n${round(3, "../../../../../etc/passwd")}\n`);
    const shot = await fetch(`${server.url}/api/sessions/${s.session.id}/rounds/1/screenshot`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(await shot.text()).toBe("PNG-bytes");
    expect((await fetch(`${server.url}/api/sessions/${s.session.id}/rounds/2/screenshot`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/sessions/${s.session.id}/rounds/3/screenshot`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/sessions/nope/rounds/1/screenshot`)).status).toBe(404);
    // the snapshot carries the rounds with their screenshot refs and diffs; the prompt named the mock
    server.store.rebuild();
    const snap = (await (await fetch(`${server.url}/api/state`)).json()) as Snapshot;
    const card = snap.sessions.find((x) => x.id === s.session.id) as StoredSession | undefined;
    expect(card?.loop.rounds.map((x) => [x.n, x.screenshotRef ?? null])).toEqual([[1, `.sdlc-state/sessions/${s.session.id}/screenshots/round-1.png`], [2, null], [3, "../../../../../etc/passwd"]]);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(stateDir, "prompt.md"), "utf8")).toContain("Visual check: a design mock is at sdlc/changes/CHG-0018/design/export-dialog.svg. No visual tool is configured in CLAUDE.md");
  }, 30_000);
});

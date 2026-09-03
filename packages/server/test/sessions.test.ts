import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { SessionRegistry, enrich, launchSession, startServer, worktreePathFor, type Snapshot } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-sess-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

function deps(dir: string, registry: SessionRegistry, env: Record<string, string> = {}) {
  return { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: { id: "eng@veri.example", name: "Eli Ng" }, claudeBin: FAKE, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env } };
}

async function viewOn(worktree: string, id: string) {
  const repo = loadRepo(await readTree(worktree, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return { repo, view: deriveChange(repo, files) };
}

describe("launchSession", () => {
  it("plan session: worktree on sdlc/<CHG>/plan, mcp.json + prompt, session.started/stopped committed, registry records init/result", async () => {
    const dir = await seeded();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const argsFile = join(dir, "args.txt");
    const r = await launchSession({ changeId: "CHG-0021" }, deps(dir, registry, { FAKE_CLAUDE_ARGS: argsFile }));
    // CHG-0021 is at stage 2 → design session by default
    expect(r.session.kind).toBe("design");
    expect(r.session.mode).toBe("HEADLESS");
    expect(r.session.branch).toBe("sdlc/CHG-0021/spec");
    const wt = worktreePathFor(dir, "sdlc/CHG-0021/spec");
    expect(existsSync(join(wt, "CLAUDE.md"))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(wt, ".sdlc-state/sessions", r.session.id, "mcp.json"), "utf8")) as { mcpServers: { sdlc: { args: string[]; env: Record<string, string> } } };
    expect(mcp.mcpServers.sdlc.args).toEqual(["/opt/sdlc/bin.js", "mcp"]);
    expect(mcp.mcpServers.sdlc.env).toMatchObject({ SDLC_SESSION: r.session.id, SDLC_CHANGE: "CHG-0021", SDLC_ACTOR_TYPE: "agent" });
    expect(readFileSync(join(wt, ".sdlc-state/sessions", r.session.id, "prompt.md"), "utf8")).toContain("mcp__sdlc__propose_artifact (index 1)");
    const code = await r.finished;
    expect(code).toBe(0);
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--output-format stream-json");
    expect(args).toContain("--permission-mode acceptEdits");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("mcp__sdlc__propose_artifact");
    expect(args).toContain("--session-id");
    expect(args).toContain("git-author=claude-code <claude-code@sdlc.local>");

    const final = registry.get(r.session.id);
    expect(final).toMatchObject({ status: "done", modelPin: "fake-model", costUsd: 0.12, numTurns: 3, exitCode: 0, harnessSessionId: "11111111-2222-3333-4444-555555555555" });
    expect(readFileSync(final?.transcriptRef ?? "", "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    const { view } = await viewOn(wt, "CHG-0021");
    const events = view.activity.slice(0, 2).map((a) => a.event);
    expect(events).toEqual(["session.stopped", "session.started"]);
    expect(view.activity[0]?.actor).toBe("system");
    const log = await git(wt, ["log", "--format=%an <%ae> %s", "-2"]);
    expect(log).toContain("sdlc-bot <sdlc-bot@sdlc.local> sdlc(CHG-0021): session");
  }, 20_000);

  it("plan sessions use plan permission mode; build sessions need a target and AUTO needs eligibility; error exits are recorded", async () => {
    const dir = await seeded();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const argsFile = join(dir, "args.txt");
    const plan = await launchSession({ changeId: "CHG-0019" }, deps(dir, registry, { FAKE_CLAUDE_ARGS: argsFile }));
    expect(plan.session.mode).toBe("PLAN");
    await plan.finished;
    expect(readFileSync(argsFile, "utf8")).toContain("--permission-mode default"); // plan mode would deny the MCP tools

    await expect(launchSession({ changeId: "CHG-0022", kind: "build" }, deps(dir, registry))).rejects.toThrow(/stage 4/);
    // CHG-0022 has no accepted spec → AUTO is not eligible; CHG-0018 (routine, 2 files, test target) is
    await expect(launchSession({ changeId: "CHG-0022", mode: "AUTO" }, deps(dir, registry))).rejects.toThrow(/AUTO is not eligible/);
    const build = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, deps(dir, registry));
    expect(build.session).toMatchObject({ kind: "build", mode: "SUPERVISED", status: "awaiting_engineer", branch: "CHG-0018/export-fix", taskId: "export-fix" });
    expect(build.session.command).toContain("--permission-mode acceptEdits");
    expect(build.session.target).toContain("zero-total");

    const failing = await launchSession({ changeId: "CHG-0022" }, deps(dir, registry, { FAKE_CLAUDE_FAIL: "1" }));
    expect(await failing.finished).toBe(1);
    expect(registry.get(failing.session.id)).toMatchObject({ status: "error", error: "boom" });
  }, 30_000);

  it("refuses a build session without any target", async () => {
    const dir = await seeded();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    // CHG-0017 is at stage 5 → not a build stage; make a stage-4 change without acceptance line by editing the seed's plan is heavy; use CHG-0018 with an empty explicit target
    await expect(launchSession({ changeId: "CHG-0018", target: "   ", mode: "SUPERVISED" }, deps(dir, registry))).rejects.toThrow(/define done/);
  });

  it("enrich merges rounds, waiting and test-edit attempts; the server snapshot lists sessions and the routes work", async () => {
    const dir = await seeded();
    const server = await startServer({ cwd: dir, identity: { id: "eng@veri.example", name: "Eli Ng" }, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, watch: false });
    cleanups.push(() => server.close());
    const registry = server.registry;
    const r = await launchSession({ changeId: "CHG-0022" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: { id: "eng@veri.example", name: "Eli Ng" }, claudeBin: FAKE });
    await r.finished;
    const { repo } = await viewOn(dir, "CHG-0022");
    const e = enrich(registry.get(r.session.id) ?? r.session, repo);
    expect(e.loop.state).toBe("not-run");
    expect(e.testEditAttempts).toBe(0);
    server.store.rebuild();
    const snap = (await (await fetch(`${server.url}/api/state`)).json()) as Snapshot;
    expect(snap.sessions.map((s) => s.id)).toContain(r.session.id);
    const cap = await fetch(`${server.url}/api/sessions/${r.session.id}/raise-cap`, { method: "POST" });
    expect(cap.status).toBe(200);
    expect((await fetch(`${server.url}/api/sessions/${r.session.id}/raise-cap`, { method: "POST" })).status).toBe(409);
    const bad = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changeId: "CHG-0022", mode: "AUTO" }) });
    expect(bad.status).toBe(409);
    const started = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changeId: "CHG-0018", mode: "AUTO" }) });
    expect(started.status).toBe(200);
    const body = (await started.json()) as { session: { id: string; mode: string; status: string } };
    expect(body.session).toMatchObject({ mode: "AUTO", status: "running" });
    await new Promise((r2) => setTimeout(r2, 800));
    expect(server.registry.get(body.session.id)?.status).toBe("done");
    expect((await fetch(`${server.url}/api/sessions/nope/stop`, { method: "POST" })).status).toBe(404);
  }, 20_000);
});

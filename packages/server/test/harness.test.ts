import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, exportChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { Engine, JobStore, SessionRegistry, StateStore, claudeCodeHarness, commandHarness, launchSession, sessionCapacity, sessionEnv, standInForStop, type Exec, type HarnessJob } from "../src/index.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** The seed with a `harness:` block appended to sdlc/config.yaml: the fake agent as the `command` harness, its round from the entry's env. */
async function seeded(round: "green" | "red" | "none", jobs: string[] | null = null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-harness-"));
  cleanups.push(() => rmRetry(dir));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const block = [
    "harness:",
    "  kind: command",
    "  id: fake-agent",
    "  command: node",
    `  args: ["${FAKE_AGENT}", "--prompt-file", "{promptFile}", "--mcp", "{mcpConfig}", "--tools", "{allowedTools}", "--session", "{sessionId}"]`,
    "  env:",
    `    FAKE_AGENT_ROUND: ${round}`,
    '    FAKE_AGENT_WORKTREE: "{worktree}"',
    ...(jobs ? [`  jobs: [${jobs.join(", ")}]`] : []),
    "",
  ].join("\n");
  appendFileSync(join(dir, "sdlc", "config.yaml"), block);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed with a command harness"]);
  return dir;
}

function deps(dir: string, registry: SessionRegistry, env: Record<string, string> = {}) {
  return { root: dir, registry, sdlcBin: FAKE_MCP, identity: ENG, claudeBin: FAKE_CLAUDE, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env } };
}

async function viewOn(worktree: string, id: string) {
  const repo = loadRepo(await readTree(worktree, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return { repo, files, view: deriveChange(repo, files) };
}

const JOB: HarnessJob = { sessionId: "sess-1", harnessSessionId: "11111111-2222-3333-4444-555555555555", kind: "build", mode: "AUTO", changeId: "CHG-0018", prompt: "Do the task; it's important", promptFile: "/wt/.sdlc-state/sessions/sess-1/prompt.md", mcpConfig: "/wt/.sdlc-state/sessions/sess-1/mcp.json", allowedTools: ["Read", "mcp__sdlc__report_round"], permissionMode: "acceptEdits", resume: false, worktree: "/wt" };

describe("harness adapters (3.8)", () => {
  it("claude-code keeps the 1.6 process line and honours everything", () => {
    const h = claudeCodeHarness("/opt/claude");
    expect(h.id).toBe("claude-code");
    expect(h.degraded).toEqual([]);
    const spec = h.spawnSpec(JOB);
    expect(spec.bin).toBe("/opt/claude");
    expect(spec.args).toEqual(["-p", JOB.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--mcp-config", JOB.mcpConfig, "--allowedTools", "Read", "mcp__sdlc__report_round", "--session-id", JOB.harnessSessionId]);
    expect(h.spawnSpec({ ...JOB, resume: true }).args.slice(-2)).toEqual(["--resume", JOB.harnessSessionId]);
    expect(spec.env).toMatchObject({ SDLC_SESSION: "sess-1", SDLC_CHANGE: "CHG-0018", SDLC_ACTOR_TYPE: "agent", GIT_AUTHOR_NAME: "claude-code", GIT_AUTHOR_EMAIL: "claude-code@sdlc.local" });
    expect(h.engineerCommand({ worktree: "/wt", sessionId: "sess-1", changeId: "CHG-0018", harnessSessionId: JOB.harnessSessionId, permissionMode: "acceptEdits", mcpConfig: JOB.mcpConfig, resume: true })).toBe(`cd /wt && SDLC_SESSION=sess-1 SDLC_CHANGE=CHG-0018 GIT_AUTHOR_NAME=claude-code GIT_AUTHOR_EMAIL=claude-code@sdlc.local GIT_COMMITTER_NAME=claude-code GIT_COMMITTER_EMAIL=claude-code@sdlc.local /opt/claude --resume ${JOB.harnessSessionId} --mcp-config ${JOB.mcpConfig} --permission-mode acceptEdits`);
  });

  it("command substitutes {placeholders} in command, args and env, hands the rest over as SDLC_* env, and declares its gaps", () => {
    const h = commandHarness({ id: "codex", command: "{worktree}/bin/codex", args: ["exec", "--mcp-config", "{mcpConfig}", "--tools", "{allowedTools}", "--read-only={readOnly}", "{prompt}", "{unknown}"], env: { CODEX_HOME: "{worktree}/.codex", SESSION: "{sessionId}/{harnessSessionId}/{changeId}" } });
    expect(h.id).toBe("codex");
    expect(h.degraded.map((d) => d.guarantee)).toEqual(["verify-before-done", "test-freeze", "plan-sync", "production-gate", "tool-allowlist", "transcript", "cost"]);
    const spec = h.spawnSpec(JOB);
    expect(spec.bin).toBe("/wt/bin/codex");
    expect(spec.args).toEqual(["exec", "--mcp-config", JOB.mcpConfig, "--tools", "Read,mcp__sdlc__report_round", "--read-only=0", "Do the task; it's important", "{unknown}"]);
    expect(spec.env).toMatchObject({ ...sessionEnv(JOB), CODEX_HOME: "/wt/.codex", SESSION: `sess-1/${JOB.harnessSessionId}/CHG-0018` });
    expect(sessionEnv(JOB)).toEqual({ SDLC_SESSION: "sess-1", SDLC_CHANGE: "CHG-0018", SDLC_ACTOR_TYPE: "agent", SDLC_AGENT_ID: "claude-code@sdlc.local", GIT_AUTHOR_NAME: "claude-code", GIT_AUTHOR_EMAIL: "claude-code@sdlc.local", GIT_COMMITTER_NAME: "claude-code", GIT_COMMITTER_EMAIL: "claude-code@sdlc.local", SDLC_PROMPT_FILE: JOB.promptFile, SDLC_MCP_CONFIG: JOB.mcpConfig, SDLC_ALLOWED_TOOLS: "Read,mcp__sdlc__report_round", SDLC_HARNESS_SESSION: JOB.harnessSessionId, SDLC_READ_ONLY: "0", SDLC_RESUME: "0" });
    expect(sessionEnv({ ...JOB, changeId: "", permissionMode: "default", resume: true })).toMatchObject({ SDLC_READ_ONLY: "1", SDLC_RESUME: "1" });
    expect(sessionEnv({ ...JOB, changeId: "" })).not.toHaveProperty("SDLC_CHANGE");
    // the engineer's line reads the prompt from its file and quotes what the shell would split
    const line = h.engineerCommand({ worktree: "/wt", sessionId: "sess-1", changeId: "CHG-0018", harnessSessionId: JOB.harnessSessionId, permissionMode: "default", mcpConfig: JOB.mcpConfig, resume: false });
    expect(line.startsWith("cd /wt && SDLC_SESSION=sess-1 SDLC_CHANGE=CHG-0018 ")).toBe(true);
    expect(line).toContain(`SESSION=sess-1/${JOB.harnessSessionId}/CHG-0018 /wt/bin/codex exec --mcp-config ${JOB.mcpConfig} --tools '' --read-only=1 "$(cat /wt/.sdlc-state/sessions/sess-1/prompt.md)" '{unknown}'`);
    expect(() => commandHarness({ id: "x", command: null, args: [], env: {} })).toThrow(/no command/);
  });

  it("standInForStop applies the hook's rule to the recorded rounds: green with output → done, red or silent or none → done-unverified", () => {
    const wt = mkdtempSync(join(tmpdir(), "sdlc-standin-"));
    cleanups.push(() => rmRetry(wt));
    const file = join(wt, ".sdlc-state", "sessions", "s1", "rounds.jsonl");
    mkdirSync(join(wt, ".sdlc-state", "sessions", "s1"), { recursive: true });
    expect(standInForStop(wt, "s1")).toMatchObject({ status: "done-unverified", patch: { standIn: { guarantee: "verify-before-done", allowed: false, rounds: 0 } } });
    expect(standInForStop(wt, "s1").patch.standIn?.reason).toContain("no verification round recorded");
    appendFileSync(file, `${JSON.stringify({ n: 1, ts: "2026-09-08T10:00:00Z", results: [{ name: "test", pass: false, exitCode: 1, outputExcerpt: "1 failed" }], dirtyHash: "0" })}\n`);
    expect(standInForStop(wt, "s1")).toMatchObject({ status: "done-unverified", patch: { standIn: { allowed: false, rounds: 1, reason: "verify-before-done: round 1 has test red — completion blocked" } } });
    appendFileSync(file, `${JSON.stringify({ n: 2, ts: "2026-09-08T10:01:00Z", results: [{ name: "test", pass: true, exitCode: 0, outputExcerpt: "" }], dirtyHash: "0" })}\n`);
    expect(standInForStop(wt, "s1").patch.standIn?.reason).toContain("no output attached for test");
    appendFileSync(file, `${JSON.stringify({ n: 3, ts: "2026-09-08T10:02:00Z", results: [{ name: "test", pass: true, exitCode: 0, outputExcerpt: "45 passed" }], dirtyHash: "0" })}\n`);
    expect(standInForStop(wt, "s1")).toEqual({ status: "done", patch: { standIn: { guarantee: "verify-before-done", allowed: true, reason: "round 3 green with output", rounds: 3 } } });
    expect(standInForStop(join(wt, "missing"), "s1").status).toBe("done-unverified");
  });

  it("a done-unverified session counts in the review backlog like a done one", () => {
    const base = { id: "s", worktree: "w", branch: "w", changeId: "CHG-0018", taskId: null, mode: "AUTO" as const, engineer: null, startedAt: "2026-09-08T10:00:00Z", heartbeatAt: "2026-09-08T10:00:00Z", target: null };
    const view = { closed: false, stage: 4 } as never;
    const cap = sessionCapacity([{ ...base, id: "a", status: "done" }, { ...base, id: "b", status: "done-unverified" }, { ...base, id: "c", status: "error" }], () => view, 1);
    expect(cap).toEqual({ active: 0, backlog: 2, ceiling: 1, over: true });
  });
});

describe("launchSession through the command harness (3.8)", () => {
  it("green round: the agent gets the prompt file, MCP config and tools; the record and session.started carry the harness and its gaps; done", async () => {
    const dir = await seeded("green");
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const argsFile = join(dir, "agent.json");
    const r = await launchSession({ changeId: "CHG-0021" }, deps(dir, registry, { FAKE_AGENT_ARGS: argsFile }));
    expect(r.session.kind).toBe("design");
    expect(r.session.harness?.id).toBe("fake-agent");
    expect(r.session.harness?.degraded.map((d) => d.guarantee)).toEqual(["verify-before-done", "test-freeze", "plan-sync", "production-gate", "tool-allowlist", "transcript", "cost"]);
    expect(r.session.transcriptRef?.endsWith("output.log")).toBe(true);
    // the engineer's line for a SUPERVISED takeover is the harness's own process line
    expect(r.session.command).toContain(`FAKE_AGENT_ROUND=green FAKE_AGENT_WORKTREE=${r.session.worktreePath} node ${FAKE_AGENT} --prompt-file ${join(r.session.worktreePath, ".sdlc-state", "sessions", r.session.id, "prompt.md")} --mcp `);
    expect(await r.finished).toBe(0);

    const wt = r.session.worktreePath;
    const stateDir = join(wt, ".sdlc-state", "sessions", r.session.id);
    const handed = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; env: Record<string, string>; cwd: string; promptHead: string };
    expect(handed.args).toEqual(["--prompt-file", join(stateDir, "prompt.md"), "--mcp", join(stateDir, "mcp.json"), "--tools", handed.env["SDLC_ALLOWED_TOOLS"], "--session", r.session.id]);
    expect(handed.env["SDLC_ALLOWED_TOOLS"]).toContain("mcp__sdlc__propose_artifact");
    expect(handed.env).toMatchObject({ SDLC_SESSION: r.session.id, SDLC_CHANGE: "CHG-0021", SDLC_ACTOR_TYPE: "agent", SDLC_PROMPT_FILE: join(stateDir, "prompt.md"), SDLC_MCP_CONFIG: join(stateDir, "mcp.json"), SDLC_READ_ONLY: "0", SDLC_RESUME: "0", GIT_AUTHOR_NAME: "claude-code", FAKE_AGENT_WORKTREE: wt });
    expect(realpathSync(handed.cwd)).toBe(realpathSync(wt));
    expect(handed.promptHead.length).toBeGreaterThan(10);
    // stdout kept verbatim, no stream-json parsing: no model pin, no cost
    const output = readFileSync(join(stateDir, "output.log"), "utf8");
    expect(output).toContain("fake agent: starting");
    expect(output).toContain('reported round → {"n":1,"loopState":"green"}');
    const final = registry.get(r.session.id);
    expect(final).toMatchObject({ status: "done", exitCode: 0, modelPin: null, costUsd: null, standIn: { guarantee: "verify-before-done", allowed: true, rounds: 1 } });
    expect(existsSync(join(stateDir, "rounds.jsonl"))).toBe(true);

    const { repo, files, view } = await viewOn(wt, "CHG-0021");
    const started = files.events.find((e) => e.event === "session.started" && e.data.session === r.session.id);
    expect(started?.event === "session.started" ? started.data.harness : null).toEqual({ id: "fake-agent", degraded: r.session.harness?.degraded });
    expect(view.activity.slice(0, 2).map((a) => a.event)).toEqual(["session.stopped", "session.started"]);
    expect(files.events.find((e) => e.event === "session.stopped" && e.data.session === r.session.id)?.data).toEqual({ session: r.session.id, reason: "done" });
    // the compliance export (3.3) carries the ledger verbatim, so the harness and its gaps are in it
    const doc = exportChange(repo, view, { exportedAt: "2026-09-08T12:00:00Z", exportedBy: { id: ENG.id } });
    const exported = doc?.events.find((e) => e.event === "session.started" && e.data.session === r.session.id);
    expect(exported?.event === "session.started" ? exported.data.harness?.degraded.map((d) => d.guarantee) : null).toContain("verify-before-done");
  }, 30_000);

  it("red round: the harness says done, the stand-in says done-unverified; session.stopped records `unverified`", async () => {
    const dir = await seeded("red");
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const r = await launchSession({ changeId: "CHG-0021" }, deps(dir, registry));
    expect(await r.finished).toBe(0);
    const final = registry.get(r.session.id);
    expect(final).toMatchObject({ status: "done-unverified", exitCode: 0, error: null });
    expect(final?.standIn).toEqual({ guarantee: "verify-before-done", allowed: false, reason: "verify-before-done: round 1 has test red — completion blocked", rounds: 1 });
    const { files } = await viewOn(r.session.worktreePath, "CHG-0021");
    expect(files.events.find((e) => e.event === "session.stopped" && e.data.session === r.session.id)?.data).toEqual({ session: r.session.id, reason: "unverified" });
  }, 30_000);

  it("no round at all: done-unverified with the hook's own reason; a `jobs` scope leaves other kinds on Claude Code", async () => {
    const dir = await seeded("none", ["design"]);
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const design = await launchSession({ changeId: "CHG-0021" }, deps(dir, registry));
    expect(await design.finished).toBe(0);
    expect(registry.get(design.session.id)).toMatchObject({ status: "done-unverified", standIn: { allowed: false, rounds: 0 } });
    expect(registry.get(design.session.id)?.standIn?.reason).toContain("no verification round recorded");
    // CHG-0019 is at stage 3 → a plan session, outside the scope → Claude Code with nothing degraded
    const plan = await launchSession({ changeId: "CHG-0019" }, deps(dir, registry));
    expect(plan.session.harness).toEqual({ id: "claude-code", degraded: [] });
    expect(plan.session.transcriptRef?.endsWith("stream.jsonl")).toBe(true);
    expect(await plan.finished).toBe(0);
    expect(registry.get(plan.session.id)).toMatchObject({ status: "done", modelPin: "fake-model", standIn: null });
  }, 30_000);
});

describe("engine with a command harness (3.8)", () => {
  const exec: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });
  async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
    const until = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > until) throw new Error("timed out waiting for the engine");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  function harness(dir: string) {
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
    const jobs = new JobStore(registry.database);
    const engine = new Engine({ store, registry, jobs, sdlcBin: FAKE_MCP, identity: ENG, claudeBin: FAKE_CLAUDE, exec, autoLaunch: true });
    cleanups.push(() => engine.close());
    return { registry, store, jobs, engine };
  }

  it("green: the AUTO build session runs through the agent, its done is verified by the stand-in, the run follows and the PR carries the plan-sync check", async () => {
    const dir = await seeded("green", ["build"]);
    await git(dir, ["rm", "-q", "sdlc/changes/CHG-0018/evals/run-1.json"]);
    await git(dir, ["commit", "-q", "-m", "drop seed run"]);
    const h = harness(dir);
    await h.store.refresh();
    await h.engine.tick();
    await waitFor(() => h.jobs.list().some((j) => j.kind === "per-change-run" && (j.state === "done" || j.state === "failed")));
    const build = h.jobs.list().find((j) => j.kind === "build-session" && j.changeId === "CHG-0018");
    expect(build?.state).toBe("done");
    const session = h.registry.get(build?.sessionId ?? "");
    expect(session).toMatchObject({ mode: "AUTO", status: "done", harness: { id: "fake-agent" }, standIn: { allowed: true } });
    const run = h.jobs.list().find((j) => j.kind === "per-change-run");
    expect(run?.state).toBe("done");
    expect(run?.note).toContain("green");
    const repo = loadRepo(await readTree(dir, "HEAD"));
    const files = repo.changes.get("CHG-0018");
    const view = deriveChange(repo, files as never);
    expect(view.stage).toBe(5);
    expect(view.pr?.checks.find((c) => c.name === "plan-sync")).toEqual({ name: "plan-sync", verdict: "pass", summary: "no PreToolUse hook in the session — checked on the run: all files are in the plan" });
  }, 40_000);

  it("red: done-unverified fails the build job with the verdict and no run follows", async () => {
    const dir = await seeded("red", ["build"]);
    await git(dir, ["rm", "-q", "sdlc/changes/CHG-0018/evals/run-1.json"]);
    await git(dir, ["commit", "-q", "-m", "drop seed run"]);
    const h = harness(dir);
    await h.store.refresh();
    await h.engine.tick();
    await waitFor(() => h.jobs.list().some((j) => j.kind === "build-session" && j.changeId === "CHG-0018" && j.state !== "running"));
    const build = h.jobs.list().find((j) => j.kind === "build-session" && j.changeId === "CHG-0018");
    expect(build?.state).toBe("failed");
    expect(build?.error).toBe("done-unverified: verify-before-done: round 1 has test red — completion blocked");
    expect(h.registry.get(build?.sessionId ?? "")?.status).toBe("done-unverified");
    await new Promise((r) => setTimeout(r, 500));
    expect(h.jobs.list().filter((j) => j.kind === "per-change-run")).toEqual([]);
    const repo = loadRepo(await readTree(dir, "HEAD"));
    expect(deriveChange(repo, repo.changes.get("CHG-0018") as never).stage).toBe(4);
  }, 40_000);
});

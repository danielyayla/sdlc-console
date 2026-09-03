import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree, commitWritePlan, git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, liftFreeze, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { installHooks, runHook, type HookInput } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function seededWorktree(changeId = "CHG-0018", slug = "export-fix"): Promise<{ root: string; wt: string }> {
  const root = mkdtempSync(join(tmpdir(), "sdlc-hooks-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  await initRepo(root, "main", { id: PO, name: "Priya Owens" });
  await git(root, ["config", "commit.gpgsign", "false"]);
  writeSeed(root);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const wt = join(root, "..", `${root.split("/").pop() ?? "wt"}-${slug}`);
  cleanups.push(() => rmSync(wt, { recursive: true, force: true }));
  await addWorktree(root, wt, `${changeId}/${slug}`);
  return { root, wt };
}

const edit = (wt: string, file: string): HookInput => ({ session_id: "sess-t", cwd: wt, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(wt, file) } });
const bash = (wt: string, command: string): HookInput => ({ session_id: "sess-t", cwd: wt, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const stop = (wt: string): HookInput => ({ session_id: "sess-t", cwd: wt, hook_event_name: "Stop", stop_hook_active: false });

function ledger(wt: string, id: string): string[] {
  return readFileSync(join(wt, `sdlc/changes/${id}/log.jsonl`), "utf8").trim().split("\n");
}

describe("test-freeze (acceptance k)", () => {
  it("blocks edits under the test globs while the repro is committed, allows source, logs the block", async () => {
    const { wt } = await seededWorktree();
    const before = ledger(wt, "CHG-0018").length;
    const blocked = await runHook("test-freeze", edit(wt, "test/export/csv.test.ts"));
    expect(blocked.exitCode).toBe(2);
    expect(blocked.reason).toContain("test-freeze blocked edit to test/export/csv.test.ts");
    const allowed = await runHook("test-freeze", edit(wt, "src/export/csv.ts"));
    expect(allowed.exitCode).toBe(0);
    const lines = ledger(wt, "CHG-0018");
    expect(lines).toHaveLength(before + 1);
    const last = JSON.parse(lines.at(-1) ?? "{}") as { event: string; actor: { type: string; session: string }; data: { hook: string; path: string } };
    expect(last).toMatchObject({ event: "hook.blocked", actor: { type: "agent", session: "sess-t" }, data: { hook: "test-freeze", path: "test/export/csv.test.ts" } });
  });
  it("honours a freeze lift the engineer recorded on the default branch (2.7): once, for that file, from the console's ledger", async () => {
    const { root, wt } = await seededWorktree();
    expect((await runHook("test-freeze", edit(wt, "test/export/csv.test.ts"))).exitCode).toBe(2);
    // the lift is a console decision committed on main; the task branch never merged it
    const repo = loadRepo(await readTree(root, "HEAD"));
    const files = repo.changes.get("CHG-0018");
    if (!files) throw new Error("CHG-0018");
    const r = liftFreeze(repo, deriveChange(repo, files), { path: "test/export/csv.test.ts", reason: "fixture needs a zero-total row" }, { now: "2026-09-04T09:00:00Z", newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9TM", actor: { id: "eng@veri.example" } });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    await commitWritePlan(root, r.plan, { identity: { id: "eng@veri.example", name: "Eli Ng" } });
    const lifted = await runHook("test-freeze", edit(wt, "test/export/csv.test.ts"));
    expect(lifted.exitCode).toBe(0);
    expect(lifted.reason).toContain("freeze lifted once for test/export/csv.test.ts");
    // other test files stay frozen; the repro test itself too
    expect((await runHook("test-freeze", edit(wt, "test/export/other.test.ts"))).exitCode).toBe(2);
    expect((await runHook("test-freeze", edit(wt, "test/export/zero-total.test.ts"))).exitCode).toBe(2);
  });
  it("does nothing for non-edit tools or outside a change branch", async () => {
    const { root, wt } = await seededWorktree();
    expect((await runHook("test-freeze", bash(wt, "ls"))).exitCode).toBe(0);
    expect((await runHook("test-freeze", edit(root, "test/export/csv.test.ts"))).exitCode).toBe(0); // main branch: no change context
  });
});

describe("plan-sync (acceptance i)", () => {
  it("blocks a commit staging a file outside the plan and allows one inside; both are logged", async () => {
    const { wt } = await seededWorktree("CHG-0017", "export");
    mkdirSync(join(wt, "src/other"), { recursive: true });
    writeFileSync(join(wt, "src/other/rogue.ts"), "export {};\n");
    await git(wt, ["add", "src/other/rogue.ts"]);
    const blocked = await runHook("plan-sync", bash(wt, "git commit -m 'x'"));
    expect(blocked.exitCode).toBe(2);
    expect(blocked.reason).toContain("src/other/rogue.ts");
    await git(wt, ["reset", "-q"]);
    mkdirSync(join(wt, "src/export"), { recursive: true });
    writeFileSync(join(wt, "src/export/csv.ts"), "export const csv = 1;\n");
    await git(wt, ["add", "src/export/csv.ts"]);
    const allowed = await runHook("plan-sync", bash(wt, "git commit -m 'in plan'"));
    expect(allowed.exitCode).toBe(0);
    const lines = ledger(wt, "CHG-0017").slice(-2).map((l) => JSON.parse(l) as { event: string; data: { hook: string } });
    expect(lines.map((e) => [e.event, e.data.hook])).toEqual([["hook.blocked", "plan-sync"], ["hook.allowed", "plan-sync"]]);
    expect((await runHook("plan-sync", bash(wt, "git status"))).logged).toBe(false);
  });
});

describe("verify-before-done (acceptance j)", () => {
  it("runs the verification commands, records the round, blocks on red with verbatim output and allows on green", async () => {
    const { wt } = await seededWorktree();
    const calls: string[] = [];
    let testExit = 1;
    const exec = (cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(cmd === "pnpm test" ? { exitCode: testExit, output: testExit ? "Tests 1 failed | 44 passed\n  ✗ zero-total row missing" : "Tests 45 passed" } : { exitCode: 0, output: "ok" });
    };
    const red = await runHook("verify-before-done", stop(wt), { exec });
    expect(red.exitCode).toBe(2);
    expect(red.reason).toContain("test red");
    expect(red.reason).toContain("zero-total row missing");
    expect(calls).toEqual(["pnpm build", "pnpm test", "pnpm lint"]);
    const rounds = readFileSync(join(wt, ".sdlc-state/sessions/sess-t/rounds.jsonl"), "utf8").trim().split("\n");
    expect(rounds).toHaveLength(1);
    const last = ledger(wt, "CHG-0018").slice(-2).map((l) => JSON.parse(l) as { event: string });
    expect(last.map((e) => e.event)).toEqual(["round", "hook.blocked"]);

    testExit = 0;
    const green = await runHook("verify-before-done", stop(wt), { exec });
    expect(green.exitCode).toBe(0);
    expect(green.reason).toContain("round 2 green");
    expect(readFileSync(join(wt, ".sdlc-state/sessions/sess-t/rounds.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect((await runHook("verify-before-done", { ...stop(wt), stop_hook_active: true }, { exec })).exitCode).toBe(0);
  });
  it("blocks when the repo has no verification block", async () => {
    const { wt } = await seededWorktree();
    writeFileSync(join(wt, "CLAUDE.md"), "# nothing\n");
    await git(wt, ["commit", "-q", "-am", "drop verification"]);
    const r = await runHook("verify-before-done", stop(wt), { exec: () => Promise.resolve({ exitCode: 0, output: "" }) });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toContain("no feedback loop");
  });
});

describe("installHooks", () => {
  it("creates wrappers and settings.json once; existing files are kept and a snippet is returned", () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-install-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const first = installHooks(root, "/opt/sdlc/bin.js");
    expect(first.created).toEqual([".claude/hooks/plan-sync.sh", ".claude/hooks/test-freeze.sh", ".claude/hooks/verify-before-done.sh", ".claude/settings.json"]);
    expect(first.snippet).toBeNull();
    const wrapper = readFileSync(join(root, ".claude/hooks/plan-sync.sh"), "utf8");
    expect(wrapper).toContain("exec sdlc hook plan-sync");
    expect(wrapper).toContain("/opt/sdlc/bin.js");
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as { hooks: { Stop: unknown[] } };
    expect(settings.hooks.Stop).toHaveLength(1);
    const second = installHooks(root, null);
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(4);
    expect(second.snippet).toContain("verify-before-done");
    expect(existsSync(dirname(join(root, ".claude/hooks/x")))).toBe(true);
  });
});

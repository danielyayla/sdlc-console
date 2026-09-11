import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_COMMANDS, INSTALL_TIMEOUT_MS, installDependencies, installExcerpt, installFailure, installFromLockfile, installTimeoutMs, type Exec, type InstallManager } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-install-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withLockfile(name: string): string {
  const dir = temp();
  writeFileSync(join(dir, name), "");
  return dir;
}

/** A recording fake manager: every call's `[cmd, cwd]`, one fixed result. */
function fakeExec(exitCode: number, output: string): Exec & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  const exec = ((cmd: string, cwd: string) => {
    calls.push([cmd, cwd]);
    return Promise.resolve({ exitCode, output });
  }) as Exec & { calls: [string, string][] };
  exec.calls = calls;
  return exec;
}

/** A `bin/` with an executable `pnpm` script, for the real `sh -c` path. */
function fakeBin(script: string): string {
  const bin = join(temp(), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  return bin;
}

describe("installFromLockfile", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
  ])("%s → %s", (file, manager) => {
    expect(installFromLockfile(withLockfile(file))).toBe(manager);
  });

  it("pnpm-lock.yaml beside yarn.lock → pnpm (first match); an empty directory → null", () => {
    const both = withLockfile("pnpm-lock.yaml");
    writeFileSync(join(both, "yarn.lock"), "");
    expect(installFromLockfile(both)).toBe("pnpm");
    expect(installFromLockfile(temp())).toBeNull();
  });
});

describe("installTimeoutMs", () => {
  it("ten minutes unless SDLC_INSTALL_TIMEOUT_MS is a positive integer", () => {
    expect(INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(installTimeoutMs({})).toBe(600_000);
    expect(installTimeoutMs({ SDLC_INSTALL_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(installTimeoutMs({ SDLC_INSTALL_TIMEOUT_MS: "0" })).toBe(600_000);
    expect(installTimeoutMs({ SDLC_INSTALL_TIMEOUT_MS: "-5" })).toBe(600_000);
    expect(installTimeoutMs({ SDLC_INSTALL_TIMEOUT_MS: "soon" })).toBe(600_000);
    expect(installTimeoutMs({ SDLC_INSTALL_TIMEOUT_MS: "1.5" })).toBe(600_000);
  });
});

describe("installDependencies with a fake exec", () => {
  it("no lockfile → null, nothing runs and no log file is written", async () => {
    const dir = temp();
    const exec = fakeExec(0, "never");
    const logFile = join(dir, ".sdlc-state", "sessions", "sess-x", "install.log");
    expect(await installDependencies(dir, { exec, logFile })).toBeNull();
    expect(exec.calls).toEqual([]);
    expect(existsSync(logFile)).toBe(false);
  });

  it.each<[string, InstallManager]>([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
  ])("%s → exactly the fixed %s command once, in the checkout, with the record", async (file, manager) => {
    const dir = withLockfile(file);
    const output = "Lockfile is up to date, resolution step is skipped\nDone in 0.3s\n";
    const exec = fakeExec(0, output);
    const record = await installDependencies(dir, { exec, now: () => new Date("2026-09-10T12:00:00.123Z") });
    expect(exec.calls).toEqual([[INSTALL_COMMANDS[manager], dir]]);
    expect(record).toMatchObject({ manager, command: INSTALL_COMMANDS[manager], exitCode: 0, output, startedAt: "2026-09-10T12:00:00Z" });
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("writes the log file under a nested path, byte for byte", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    const output = "Progress: resolved 239, reused 239, downloaded 0, added 239, done\n\n WARN  Ignored build scripts: better-sqlite3.\n";
    const logFile = join(dir, ".sdlc-state", "sessions", "sess-abc", "install.log");
    await installDependencies(dir, { exec: fakeExec(0, output), logFile });
    expect(readFileSync(logFile, "utf8")).toBe(output);
  });

  it("a non-zero exit comes back with its code and the whole output, and does not throw", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    const output = "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with package.json\n\nNote that in CI environments this setting is true by default.\n";
    const record = await installDependencies(dir, { exec: fakeExec(2, output) });
    expect(record).toMatchObject({ manager: "pnpm", exitCode: 2, output });
  });
});

describe("installDependencies through sh -c (offline, a fake pnpm on PATH)", () => {
  it("runs the fixed command in the checkout with CI=1 and FORCE_COLOR=0, capturing stdout and stderr", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    const bin = fakeBin('echo "cwd=$PWD"; echo "args=$*"; echo "ci=$CI force_color=$FORCE_COLOR"; echo "to stderr" >&2; exit 0');
    const record = await installDependencies(dir, { env: { PATH: `${bin}:/bin:/usr/bin` } });
    expect(record?.exitCode).toBe(0);
    expect(record?.output).toContain(`cwd=${realpathSync(dir)}`);
    expect(record?.output).toContain("args=install --frozen-lockfile --prefer-offline");
    expect(record?.output).toContain("ci=1 force_color=0");
    expect(record?.output).toContain("to stderr");
  });

  it("a failing manager: its exit code and its stderr", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    const bin = fakeBin('echo boom >&2; exit 3');
    const record = await installDependencies(dir, { env: { PATH: `${bin}:/bin:/usr/bin` } });
    expect(record).toMatchObject({ exitCode: 3 });
    expect(record?.output).toContain("boom");
  });

  it("a timeout: exit -1 with the timeout appended; the child is killed, not awaited", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    const bin = fakeBin("sleep 5; echo never");
    const t0 = Date.now();
    const record = await installDependencies(dir, { env: { PATH: `${bin}:/bin:/usr/bin` }, timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(record?.exitCode).toBe(-1);
    expect(record?.output).toContain("timed out after 200 ms");
    expect(record?.output).not.toContain("never");
  });

  it("no manager on PATH: the shell's 127 with `not found` in the output", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    // a shell but no pnpm: an empty bin ahead of /bin (sh lives there; a package manager never does)
    const empty = join(temp(), "empty-bin");
    mkdirSync(empty);
    const record = await installDependencies(dir, { env: { PATH: `${empty}:/bin` } });
    expect(record?.exitCode).toBe(127);
    expect(record?.output).toContain("not found");
  });

  it("no shell at all: exit -1 with the spawn error in the output, nothing thrown", async () => {
    const dir = withLockfile("pnpm-lock.yaml");
    const record = await installDependencies(dir, { env: { PATH: "/nonexistent" } });
    expect(record?.exitCode).toBe(-1);
    expect(record?.output).toContain("ENOENT");
  });
});

describe("installExcerpt and installFailure", () => {
  it("the excerpt is the trimmed 600-character tail", () => {
    const excerpt = installExcerpt(`  ${"x".repeat(1000)}\n`);
    expect(excerpt).toHaveLength(600);
    expect(excerpt).toBe(excerpt.trim());
    expect(installExcerpt("short\n")).toBe("short");
  });

  it("the failure is a retryable 502 carrying the whole output as its one diagnostic", () => {
    const output = "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"\n";
    const e = installFailure("/repo/.sdlc-state/worktrees/CHG-0001__work", { manager: "pnpm", command: INSTALL_COMMANDS.pnpm, exitCode: 1, startedAt: "2026-09-10T12:00:00Z", durationMs: 12, output });
    expect(e.status).toBe(502);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("dependency install failed in /repo/.sdlc-state/worktrees/CHG-0001__work: pnpm install --frozen-lockfile --prefer-offline exited 1");
    expect(e.diagnostics).toEqual([{ path: "/repo/.sdlc-state/worktrees/CHG-0001__work", severity: "error", message: output, rule: "session.install-failed" }]);
  });
});

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addWorktree, currentBranch, gitRaw } from "@sdlc/adapter-git";
import type { Exec } from "../engine/runner.js";
import { ActionError } from "../store.js";

/**
 * Dependency install as a step of worktree preparation (CHG-0007). A session
 * worktree is a fresh checkout: without this step every verify round in it is
 * red for `tsc: command not found`. The lockfile picks the manager, the
 * command is fixed, frozen and offline-first, and whatever the manager prints
 * is kept verbatim on the session record; nothing in config, env or CLI skips
 * or replaces it (a repository without a lockfile is the only no-install case).
 */

export type InstallManager = "pnpm" | "npm" | "yarn";
/** The Install step a lockfile names; `null` when the repository has none (the CI workflows and the launcher share this rule). */
export type InstallStep = InstallManager | null;

/** The Install step follows the lockfile present: pnpm, npm (lock or shrinkwrap), yarn; none means no step. */
export function installFromLockfile(dir: string): InstallStep {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json"))) return "npm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return null;
}

/** The one command per manager: frozen to the lockfile, the store before the network, no audit or funding noise. */
export const INSTALL_COMMANDS: Readonly<Record<InstallManager, string>> = {
  pnpm: "pnpm install --frozen-lockfile --prefer-offline",
  npm: "npm ci --prefer-offline --no-audit --no-fund",
  yarn: "yarn install --immutable",
};

export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** `SDLC_INSTALL_TIMEOUT_MS` when it is a positive integer, else ten minutes. */
export function installTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env["SDLC_INSTALL_TIMEOUT_MS"];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : INSTALL_TIMEOUT_MS;
}

/** The install that prepared a worktree, verbatim: the whole captured output, never a summary. */
export interface InstallRecord {
  manager: InstallManager;
  command: string;
  /** The manager's exit code; `-1` for a timeout or a spawn failure, with the reason appended to `output`. */
  exitCode: number;
  startedAt: string;
  durationMs: number;
  output: string;
}

export interface InstallOptions {
  /** Runs the command (tests inject a fake); `sh -c` in the checkout otherwise. */
  exec?: Exec;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  timeoutMs?: number;
  /** Where to write the output as well (the session's `install.log`); its directory is created. */
  logFile?: string;
}

function shell(cmd: string, cwd: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      let output = `${stdout}${stderr ? `\n${stderr}` : ""}`;
      let exitCode = 0;
      if (error) {
        const e = error as Error & { killed?: boolean; code?: unknown };
        if (e.killed) {
          exitCode = -1;
          output += `\ntimed out after ${timeoutMs} ms`;
        } else if (typeof e.code === "number") {
          exitCode = e.code;
        } else {
          // the shell itself could not be spawned: better recorded than thrown, so the launch is refused through the one path
          exitCode = -1;
          output += `\n${e.message}`;
        }
      }
      resolve({ exitCode, output });
    });
  });
}

/**
 * Install the checkout's dependencies with the manager its lockfile names.
 * Returns `null` without a lockfile (nothing runs, nothing is written) and
 * the record otherwise, whatever the exit code: the caller decides what a
 * failure means. Never throws.
 */
export async function installDependencies(checkout: string, opts: InstallOptions = {}): Promise<InstallRecord | null> {
  const manager = installFromLockfile(checkout);
  if (!manager) return null;
  const command = INSTALL_COMMANDS[manager];
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? installTimeoutMs(env);
  const startedAt = (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const t0 = Date.now();
  const run = opts.exec ? opts.exec(command, checkout) : shell(command, checkout, env, timeoutMs);
  const { exitCode, output } = await run;
  const durationMs = Date.now() - t0;
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    writeFileSync(opts.logFile, output);
  }
  return { manager, command, exitCode, startedAt, durationMs, output };
}

/** The ledger tail of an install's output: the same 600-character rule `round.results[].outputExcerpt` gets on `log.jsonl`. */
export function installExcerpt(output: string): string {
  return output.trim().slice(-600);
}

/** The refusal a failed install becomes (R6): retryable, the whole output as the one diagnostic. */
export function installFailure(checkout: string, install: InstallRecord): ActionError {
  return new ActionError(502, `dependency install failed in ${checkout}: ${install.command} exited ${install.exitCode}`, [{ path: checkout, severity: "error", message: install.output, rule: "session.install-failed" }], true);
}

export interface PreparedWorktree {
  checkout: string;
  /** Whether this call added the worktree (false: an earlier launch, a fetch or a resume left it in place). */
  created: boolean;
  /** The install that ran, whatever its exit code; null when the checkout has no lockfile. */
  install: InstallRecord | null;
}

export interface PrepareOptions {
  /** `worktreePathFor(root, branch)`, computed by the caller. */
  checkout: string;
  defaultBranch: string;
  exec?: Exec;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/**
 * Worktree preparation shared by `launchSession` and `launchBandSession`: add
 * the checkout when it is missing (prune first, cut from the default branch or
 * from HEAD when the root is on it), then install its dependencies on every
 * launch — a reused checkout may have a moved lockfile, and the manager's own
 * no-op is the skip. The exit code is returned, not judged.
 */
export async function prepareWorktree(root: string, branch: string, opts: PrepareOptions): Promise<PreparedWorktree> {
  const { checkout } = opts;
  let created = false;
  if (!existsSync(checkout)) {
    mkdirSync(join(root, ".sdlc-state", "worktrees"), { recursive: true });
    // the cache directory is disposable: a checkout deleted with it is pruned so its branch can be checked out again
    await gitRaw(root, ["worktree", "prune"]);
    const onBase = (await currentBranch(root)) === opts.defaultBranch ? "HEAD" : opts.defaultBranch;
    await addWorktree(root, checkout, branch, onBase);
    created = true;
  }
  const env = opts.env ?? process.env;
  const install = await installDependencies(checkout, { env, timeoutMs: installTimeoutMs(env), ...(opts.exec ? { exec: opts.exec } : {}), ...(opts.now ? { now: opts.now } : {}) });
  return { checkout, created, install };
}

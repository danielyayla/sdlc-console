import { execFile } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export interface GitOptions {
  input?: string | Buffer;
  /** Extra environment (e.g. GIT_AUTHOR_*). */
  env?: Record<string, string>;
  /** Return the raw buffer instead of a utf8 string. */
  binary?: boolean;
}

/** Run git without throwing; callers decide what a non-zero exit means. */
export function gitRaw(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult & { buffer: Buffer }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env }, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr));
        resolve({ stdout: out.toString("utf8"), stderr: err.toString("utf8"), code, buffer: out });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** Run git; throw GitError on non-zero exit. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await gitRaw(cwd, args, opts);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout;
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await gitRaw(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export async function headSha(dir: string, ref = "HEAD"): Promise<string> {
  return (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function defaultBranch(dir: string): Promise<string> {
  const r = await gitRaw(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    const has = await gitRaw(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (has.code === 0) return candidate;
  }
  return currentBranch(dir);
}

export async function localBranches(dir: string): Promise<string[]> {
  const out = await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface GitIdentity {
  id: string;
  name: string;
}

/** The acting human's identity from git config (local mode, decisions §12.4). */
export async function identity(dir: string): Promise<GitIdentity | null> {
  const email = await gitRaw(dir, ["config", "user.email"]);
  const name = await gitRaw(dir, ["config", "user.name"]);
  if (email.code !== 0 || email.stdout.trim() === "") return null;
  return { id: email.stdout.trim(), name: name.stdout.trim() || email.stdout.trim() };
}

/** `git init -b <branch>` with an identity; used by `sdlc init` on a bare folder and by tests. */
export async function initRepo(dir: string, branch = "main", who?: GitIdentity): Promise<void> {
  await git(dir, ["init", "-q", "-b", branch]);
  if (who) {
    await git(dir, ["config", "user.email", who.id]);
    await git(dir, ["config", "user.name", who.name]);
  }
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  return (await gitRaw(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).code === 0;
}

/** True when `ancestor` is reachable from `ref` (already merged). */
export async function isAncestor(dir: string, ancestor: string, ref = "HEAD"): Promise<boolean> {
  return (await gitRaw(dir, ["merge-base", "--is-ancestor", ancestor, ref])).code === 0;
}

import { git, gitRaw, type GitIdentity } from "./git.js";

/** URL of a remote, or null when it is not configured. */
export async function remoteUrl(dir: string, remote = "origin"): Promise<string | null> {
  const r = await gitRaw(dir, ["remote", "get-url", remote]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Push a local branch to the remote (same name); the caller's git credentials apply. */
export async function pushBranch(dir: string, branch: string, remote = "origin"): Promise<void> {
  await git(dir, ["push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
}

export async function fetchRemote(dir: string, remote = "origin", ref?: string): Promise<void> {
  await git(dir, ref ? ["fetch", "--quiet", remote, ref] : ["fetch", "--quiet", remote]);
}

export type FastForwardResult = { refused: false; head: string; moved: boolean } | { refused: true; reason: string };

/**
 * Fast-forward local `branch` to `remote`'s without a checkout. The plain
 * fetch runs first so a network or auth failure throws as it does everywhere
 * else; then `git fetch <remote> <branch>:<branch>` moves the ref. Git refuses
 * that update — returned as `{ refused: true }`, never thrown — when it is not
 * a fast-forward (the refspec has no `+`, so local commits are never
 * discarded) and when the branch is checked out in this or any linked
 * worktree. Never `--update-head-ok`, never `update-ref`: git's refusal is
 * what keeps a checked-out branch and its index together.
 */
export async function fastForwardBranch(dir: string, branch: string, remote = "origin"): Promise<FastForwardResult> {
  await fetchRemote(dir, remote, branch);
  const ref = `refs/heads/${branch}`;
  const before = (await git(dir, ["rev-parse", ref])).trim();
  const r = await gitRaw(dir, ["fetch", remote, `${branch}:${branch}`]); // not --quiet: the refusal's reason is on stderr
  if (r.code !== 0) return { refused: true, reason: r.stderr.trim() || `fetch ${remote} ${branch}:${branch} failed (${r.code})` };
  const head = (await git(dir, ["rev-parse", ref])).trim();
  return { refused: false, head, moved: head !== before };
}

/**
 * Bring `origin/<branch>` into the checked-out branch after a merge performed
 * on the code host. Fast-forwards when possible; otherwise a merge commit
 * under `who` joins the console's local lifecycle commits with the remote.
 * Returns the local head afterwards.
 */
export async function mergeRemoteBranch(dir: string, branch: string, message: string, who: GitIdentity, remote = "origin", committer: GitIdentity = who): Promise<string> {
  await fetchRemote(dir, remote, branch);
  const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.id, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.id };
  const ff = await gitRaw(dir, ["merge", "--ff-only", "--quiet", "FETCH_HEAD"], { env });
  if (ff.code !== 0) await git(dir, ["merge", "--no-edit", "-m", message, "FETCH_HEAD"], { env });
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

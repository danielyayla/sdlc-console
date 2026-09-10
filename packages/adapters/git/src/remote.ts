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

/**
 * Fast-forward local `branch` to `remote`'s without a checkout: `git fetch
 * <remote> <branch>:<branch>`. Git refuses a non-fast-forward (never `+`, so
 * local commits are never discarded) and a branch checked out in any
 * worktree; both come back as `{ ok: false }` for the caller to merge instead.
 */
export async function fastForwardBranch(dir: string, branch: string, remote = "origin"): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const r = await gitRaw(dir, ["fetch", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `fetch ${remote} ${branch}:${branch} failed (${r.code})` };
  return { ok: true, head: (await git(dir, ["rev-parse", `refs/heads/${branch}`])).trim() };
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

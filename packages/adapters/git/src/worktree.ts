import { git, gitRaw } from "./git.js";

export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
}

/** One worktree per task: new branch `<CHG>/<slug>` from `base` at `path`. */
export async function addWorktree(dir: string, path: string, branch: string, base = "HEAD"): Promise<void> {
  const exists = await gitRaw(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code === 0) await git(dir, ["worktree", "add", path, branch]);
  else await git(dir, ["worktree", "add", "-b", branch, path, base]);
}

export async function removeWorktree(dir: string, path: string, force = false): Promise<void> {
  await git(dir, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  await gitRaw(dir, ["worktree", "prune"]);
}

export async function listWorktrees(dir: string): Promise<Worktree[]> {
  const out = await git(dir, ["worktree", "list", "--porcelain"]);
  const items: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur?.path) items.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null, bare: cur.bare ?? false });
      cur = { path: line.slice(9), branch: null, bare: false };
    } else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5);
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare" && cur) cur.bare = true;
  }
  if (cur?.path) items.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null, bare: cur.bare ?? false });
  return items;
}

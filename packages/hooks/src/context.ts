import { currentBranch, isRepo, readTree, repoRoot } from "@sdlc/adapter-git";
import { deriveChange, loadRepo, type ChangeFiles, type ChangeView, type Repo } from "@sdlc/core";
import type { HookInput } from "./input.js";

export interface HookContext {
  root: string;
  branch: string;
  changeId: string;
  repo: Repo;
  files: ChangeFiles;
  view: ChangeView;
}

/** Change id from a task branch `CHG-NNNN/<slug>` or the `SDLC_CHANGE` env. */
export function changeIdFrom(branch: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env["SDLC_CHANGE"];
  if (fromEnv && /^CHG-\d{4}$/.test(fromEnv)) return fromEnv;
  const m = /^(CHG-\d{4})(?:\/|$)/.exec(branch);
  return m?.[1] ?? null;
}

/** Resolve the worktree, its change and the derived view; null when the hook runs outside a change context. */
export async function hookContext(input: HookInput, env: Record<string, string | undefined>): Promise<HookContext | null> {
  if (!(await isRepo(input.cwd))) return null;
  const root = await repoRoot(input.cwd);
  const branch = await currentBranch(root);
  const changeId = changeIdFrom(branch, env);
  if (!changeId) return null;
  const repo = loadRepo(await readTree(root, "HEAD"));
  const files = repo.changes.get(changeId);
  if (!files) return null;
  return { root, branch, changeId, repo, files, view: deriveChange(repo, files) };
}

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
  const merged = await withDefaultBranchLedger(root, branch, repo, files);
  return { root, branch, changeId, repo, files: merged, view: deriveChange(repo, merged) };
}

/**
 * Human decisions about a session (a freeze lift, a repro confirmation) are
 * committed on the default branch by the console; the task branch only
 * receives them at merge time. The hook reads both ledgers so a lift recorded
 * in the console is honoured in the worktree it was granted for.
 */
async function withDefaultBranchLedger(root: string, branch: string, repo: Repo, files: ChangeFiles): Promise<ChangeFiles> {
  const base = repo.config.defaultBranch;
  if (branch === base) return files;
  try {
    const baseRepo = loadRepo(await readTree(root, base, { prefixes: [`sdlc/changes/${files.id}`, "sdlc/config.yaml"] }));
    const baseFiles = baseRepo.changes.get(files.id);
    if (!baseFiles) return files;
    const known = new Set(files.events.map((e) => e.id));
    const extra = baseFiles.events.filter((e) => !known.has(e.id));
    if (extra.length === 0 && !baseFiles.change) return files;
    // the console's change.yaml (repro committed, freeze active) is the newer truth for a task branch cut before it
    const change = files.change && baseFiles.change && baseFiles.change.repro?.state === "committed" && files.change.repro?.state !== "committed" ? { ...files.change, repro: baseFiles.change.repro } : files.change;
    return { ...files, change, events: [...files.events, ...extra] };
  } catch {
    return files;
  }
}

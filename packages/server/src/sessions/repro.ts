import { git } from "@sdlc/adapter-git";
import { clearReproDraft, readReproDraft, writeReproDraft, type ReproDraft } from "@sdlc/mcp";
import { ActionError } from "../store.js";
import { launchSession, type LaunchDeps } from "./launcher.js";
import type { SessionRegistry, StoredSession } from "./registry.js";

export interface DraftOwner {
  session: StoredSession;
  draft: ReproDraft;
}

/** The build session of a change that reported a repro test still awaiting the engineer (newest first). */
export function reproDraftFor(registry: SessionRegistry, changeId: string): DraftOwner | null {
  for (const s of registry.list()) {
    if (s.changeId !== changeId || s.kind !== "build") continue;
    const draft = readReproDraft(s.worktreePath, s.id);
    if (draft) return { session: s, draft };
  }
  return null;
}

/** The repro commit must contain the test alone (spec 5B.3 "confirm commits the test alone"); verified by sha in the shared object store, never from the draft. */
export async function verifyReproCommit(root: string, sha: string, testPath: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ActionError(400, "repro needs the sha of the commit containing the failing test");
  const touched = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).catch(() => null))?.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!touched) throw new ActionError(409, `commit ${sha.slice(0, 7)} is not in this repository`);
  if (touched.length !== 1 || touched[0] !== testPath) throw new ActionError(409, `commit ${sha.slice(0, 7)} touches ${touched.join(", ") || "nothing"}; the repro commit must contain ${testPath} alone`);
}

export function markReproRejected(owner: DraftOwner, reason: string, at: string): void {
  writeReproDraft(owner.session.worktreePath, owner.session.id, { ...owner.draft, rejected: { reason, at } });
}

export function clearRepro(owner: DraftOwner): void {
  clearReproDraft(owner.session.worktreePath, owner.session.id);
}

/**
 * After the engineer decided, the reporting session continues: resumed with
 * the decision as guidance when it has ended (a headless harness takes no
 * input mid-run). Returns the resumed session, or null when it is still
 * running or no launcher is available.
 */
export async function resumeAfterRepro(owner: DraftOwner, guidance: string, deps: LaunchDeps | null): Promise<StoredSession | null> {
  const s = owner.session;
  if (!deps || s.status === "running" || s.status === "awaiting_engineer") return null;
  const r = await launchSession({ changeId: s.changeId, kind: "build", ...(s.taskId ? { taskId: s.taskId } : {}), ...(s.target ? { target: s.target } : {}), mode: s.mode, resume: { sessionId: s.id, guidance } }, deps);
  return r.session;
}

import { deriveChange, overrideMode } from "@sdlc/core";
import { ActionError, type StateStore } from "../store.js";
import { engineerCommand } from "./launcher.js";
import type { SessionRegistry, StoredSession } from "./registry.js";

export interface DowngradeDeps {
  store: StateStore;
  registry: SessionRegistry;
  claudeBin?: string | undefined;
  now?: (() => Date) | undefined;
  kill?: ((pid: number) => void) | undefined;
}

export interface DowngradeResult {
  session: StoredSession;
  commit: string;
}

/**
 * AUTO → SUPERVISED (FR-22, P9): record the engineer's override on the ledger,
 * park the session as awaiting the engineer with a `--resume` command for the
 * same harness session, then end the headless harness. The worktree keeps
 * every commit the agent made; the engineer continues at the keyboard.
 */
export async function downgradeSession(deps: DowngradeDeps, id: string, reason?: string): Promise<DowngradeResult> {
  const s = deps.registry.get(id);
  if (!s) throw new ActionError(404, `${id} not found`);
  if (s.mode !== "AUTO" && s.mode !== "HEADLESS") throw new ActionError(409, `${id} is ${s.mode}; only AUTO or HEADLESS sessions can be downgraded to SUPERVISED`);
  if (s.status !== "running" && s.status !== "waiting") throw new ActionError(409, `${id} is ${s.status}; a downgrade takes autonomy from a running session`);
  const from = s.mode;
  const { commit } = await deps.store.act((repo, ctx) => {
    const files = repo.changes.get(s.changeId);
    if (!files) throw new ActionError(404, `${s.changeId} not found`);
    return overrideMode(repo, deriveChange(repo, files), { session: id, from, to: "SUPERVISED", reason }, ctx);
  });
  const now = (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const patched = deps.registry.patch(id, {
    mode: "SUPERVISED",
    status: "awaiting_engineer",
    heartbeatAt: now,
    waitingOnYou: { reason: "downgraded — continue the session in your terminal" },
    command: engineerCommand({ ...s, mode: "SUPERVISED" }, deps.claudeBin ?? "claude", true),
  });
  if (s.pid) {
    try {
      (deps.kill ?? ((pid) => process.kill(pid, "SIGTERM")))(s.pid);
    } catch {
      // already gone
    }
  }
  return { session: patched ?? s, commit };
}

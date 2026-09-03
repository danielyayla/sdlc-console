import { Engine, JobStore, SessionRegistry, StateStore, type Job } from "@sdlc/server";
import { actingIdentity, assertHuman, repoContext } from "../context.js";
import { CliError, type Io } from "../io.js";
import { sdlcBinPath } from "./session.js";

/** `sdlc run <CHG>`: execute the per-change run for the change's task worktree and apply the outcome. */
export async function runCommand(io: Io, changeId: string): Promise<Job> {
  assertHuman(io);
  const ctx = await repoContext(io, false);
  const who = await actingIdentity(ctx);
  const registry = new SessionRegistry(ctx.root);
  try {
    const store = new StateStore({ root: ctx.root, identity: who, sessions: () => registry.list() });
    await store.refresh();
    const engine = new Engine({ store, registry, jobs: new JobStore(registry.database), sdlcBin: sdlcBinPath(), identity: who, autoLaunch: false, log: (l) => io.stderr(`${l}\n`) });
    const job = await engine.runForChange(changeId);
    engine.close();
    if (!job) throw new CliError(`no build session or task worktree for ${changeId}; start one with sdlc session start ${changeId}`, 2);
    return job;
  } finally {
    registry.close();
  }
}

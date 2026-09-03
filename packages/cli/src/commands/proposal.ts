import { SessionRegistry, StateStore, acceptProposalAction, proposalDismiss, type ActionResult } from "@sdlc/server";
import { actingIdentity, assertHuman, repoContext, type CliContext } from "../context.js";
import { CliError, type Io } from "../io.js";

async function withStore<T>(ctx: CliContext, fn: (store: StateStore) => Promise<T>): Promise<T> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const registry = new SessionRegistry(ctx.root);
  try {
    const store = new StateStore({ root: ctx.root, identity: who, sessions: () => registry.list() });
    await store.refresh();
    return await fn(store);
  } finally {
    registry.close();
  }
}

/** `sdlc proposal accept <PRP>`: the line goes on `sdlc/proposals/<PRP>` and, in GitHub mode, into a PR for the code owners. The console merges nothing. */
export function proposalAccept(ctx: CliContext, id: string): Promise<ActionResult> {
  return withStore(ctx, (store) => acceptProposalAction(store, id, ctx.io.env));
}

export function proposalDismissCommand(ctx: CliContext, id: string, reason: string): Promise<ActionResult> {
  if (reason.trim() === "") throw new CliError("--reason is required to dismiss a proposal", 2);
  return withStore(ctx, (store) => proposalDismiss(store, id, reason));
}

const USAGE = "usage: sdlc proposal accept <PRP> | sdlc proposal dismiss <PRP> --reason <text>";

export async function proposalCommand(io: Io, sub: string | undefined, rest: string[], values: Record<string, string | boolean | undefined>, json: boolean): Promise<{ value: unknown; text: string }> {
  const ctx = await repoContext(io, json);
  const id = rest[0];
  if (sub === "accept" && id) {
    const r = await proposalAccept(ctx, id);
    return { value: r, text: `${r.toast} · ${r.commit.slice(0, 7)}` };
  }
  if (sub === "dismiss" && id) {
    const r = await proposalDismissCommand(ctx, id, typeof values["reason"] === "string" ? values["reason"] : "");
    return { value: r, text: `${r.toast} · ${r.commit.slice(0, 7)}` };
  }
  throw new CliError(USAGE);
}

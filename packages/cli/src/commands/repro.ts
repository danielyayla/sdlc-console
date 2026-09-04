import { SessionRegistry, StateStore, clearRepro, confirmReproTest, dismissPrAutoFinding, liftTestFreeze, markReproRejected, rejectReproTest, reproDraftFor, verifyReproCommit, type ActionResult } from "@sdlc/server";
import { actingIdentity, assertHuman, repoContext, type CliContext } from "../context.js";
import { CliError, type Io } from "../io.js";

async function withStore<T>(ctx: CliContext, fn: (store: StateStore, registry: SessionRegistry) => Promise<T>): Promise<T> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const registry = new SessionRegistry(ctx.root);
  try {
    const store = new StateStore({ root: ctx.root, identity: who, sessions: () => registry.list() });
    await store.refresh();
    return await fn(store, registry);
  } finally {
    registry.close();
  }
}

export interface ReproConfirmOptions {
  testPath?: string | undefined;
  failureReason?: string | undefined;
  sha?: string | undefined;
  output?: string | undefined;
}

/** `sdlc repro confirm <CHG>`: the session's reported test by default; explicit fields for a repro written by hand. The commit is verified either way. */
export async function reproConfirm(ctx: CliContext, id: string, opts: ReproConfirmOptions): Promise<ActionResult & { resumeHint: string | null }> {
  return withStore(ctx, async (store, registry) => {
    const owner = reproDraftFor(registry, id);
    const input = { testPath: opts.testPath ?? owner?.draft.testPath ?? "", failureReason: opts.failureReason ?? owner?.draft.failureReason ?? "", sha: opts.sha ?? owner?.draft.sha ?? "", output: opts.output ?? owner?.draft.output ?? "" };
    if (!input.testPath || !input.failureReason || !input.sha) throw new CliError(`${id} has no reported repro test; pass --file, --reason and --sha for one written by hand`, 2);
    await verifyReproCommit(ctx.root, input.sha, input.testPath);
    const r = await confirmReproTest(store, id, input);
    if (owner) clearRepro(owner);
    return { ...r, resumeHint: owner ? `session ${owner.session.id} continues under the freeze: sdlc session start ${id} … or resume it from the console` : null };
  });
}

export async function reproReject(ctx: CliContext, id: string, reason: string, testPath?: string): Promise<ActionResult> {
  if (reason.trim() === "") throw new CliError("--reason is required to send a repro test back", 2);
  return withStore(ctx, async (store, registry) => {
    const owner = reproDraftFor(registry, id);
    const path = testPath ?? owner?.draft.testPath;
    if (!path) throw new CliError(`${id} has no reported repro test; pass --file`, 2);
    const r = await rejectReproTest(store, id, { testPath: path, reason });
    if (owner) markReproRejected(owner, reason, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    return r;
  });
}

export async function freezeLift(ctx: CliContext, id: string, path: string, reason: string): Promise<ActionResult> {
  return withStore(ctx, (store) => liftTestFreeze(store, id, { path, reason }));
}

export async function freezeDismiss(ctx: CliContext, id: string, path: string, reason: string): Promise<ActionResult> {
  return withStore(ctx, (store) => dismissPrAutoFinding(store, id, { path, reason }));
}

const USAGE_REPRO = "usage: sdlc repro confirm <CHG> [--file <test> --reason <failure> --sha <commit>] | sdlc repro reject <CHG> --reason <text> [--file <test>]";
const USAGE_FREEZE = "usage: sdlc freeze lift <CHG> --file <path> --reason <text> | sdlc freeze dismiss <CHG> --file <path> --reason <text>";

export async function reproCommand(io: Io, sub: string | undefined, rest: string[], values: Record<string, string | boolean | undefined>, json: boolean): Promise<{ value: unknown; text: string }> {
  const ctx = await repoContext(io, json);
  const id = rest[0];
  const s = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  if (sub === "confirm" && id) {
    const r = await reproConfirm(ctx, id, { testPath: s("file"), failureReason: s("reason"), sha: s("sha"), output: s("output") });
    return { value: r, text: `${r.toast} · ${r.commit.slice(0, 7)}${r.resumeHint ? `\n${r.resumeHint}` : ""}` };
  }
  if (sub === "reject" && id) {
    const r = await reproReject(ctx, id, s("reason") ?? "", s("file"));
    return { value: r, text: `${r.toast} · ${r.commit.slice(0, 7)}` };
  }
  throw new CliError(USAGE_REPRO);
}

export async function freezeCommand(io: Io, sub: string | undefined, rest: string[], values: Record<string, string | boolean | undefined>, json: boolean): Promise<{ value: unknown; text: string }> {
  const ctx = await repoContext(io, json);
  const id = rest[0];
  const file = typeof values["file"] === "string" ? values["file"] : "";
  const reason = typeof values["reason"] === "string" ? values["reason"] : "";
  if ((sub === "lift" || sub === "dismiss") && id && file && reason) {
    const r = sub === "lift" ? await freezeLift(ctx, id, file, reason) : await freezeDismiss(ctx, id, file, reason);
    return { value: r, text: `${r.toast} · ${r.commit.slice(0, 7)}` };
  }
  throw new CliError(USAGE_FREEZE);
}

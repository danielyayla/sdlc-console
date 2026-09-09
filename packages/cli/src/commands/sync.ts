import type { HostedCodeHost } from "@sdlc/adapter-git";
import { StateStore, hostedCodeHostFor, syncCodeHost, type SyncSummary } from "@sdlc/server";
import { actingIdentity, assertHuman, loadCommitted, type CliContext } from "../context.js";
import { CliError } from "../io.js";

/** One hosted-mode pass from the CLI: artifact PRs / MRs, merges done on the host, the records PR. */
export async function syncCommand(ctx: CliContext): Promise<SyncSummary> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  if (repo.config.codeHost === "local") throw new CliError("sync applies to hosted mode only (config.codeHost: github or gitlab)", 2);
  let host: HostedCodeHost;
  try {
    host = hostedCodeHostFor(repo.config.codeHost, ctx.io.env);
  } catch (e) {
    throw new CliError((e as Error).message, 2);
  }
  const store = new StateStore({ root: ctx.root, identity: who });
  await store.refresh();
  return syncCodeHost({ host, identity: who, log: (l) => ctx.io.stderr(`${l}\n`) }, store);
}

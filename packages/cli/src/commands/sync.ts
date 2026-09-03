import type { GitHubCodeHost } from "@sdlc/adapter-github";
import { StateStore, codeHostFor, syncGitHub, type SyncSummary } from "@sdlc/server";
import { actingIdentity, assertHuman, loadCommitted, type CliContext } from "../context.js";
import { CliError } from "../io.js";

/** One GitHub-mode pass from the CLI: artifact PRs, merges done on GitHub, the records PR. */
export async function syncCommand(ctx: CliContext): Promise<SyncSummary> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const { repo } = await loadCommitted(ctx);
  if (repo.config.codeHost !== "github") throw new CliError("sync applies to GitHub mode only (config.codeHost: github)", 2);
  let host: GitHubCodeHost;
  try {
    host = codeHostFor("github", ctx.io.env) as GitHubCodeHost;
  } catch (e) {
    throw new CliError((e as Error).message, 2);
  }
  const store = new StateStore({ root: ctx.root, identity: who });
  await store.refresh();
  return syncGitHub({ host, identity: who, log: (l) => ctx.io.stderr(`${l}\n`) }, store);
}

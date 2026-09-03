import type { AddressInfo } from "node:net";
import { identity as gitIdentity, isRepo, repoRoot, type GitIdentity } from "@sdlc/adapter-git";
import { createApp } from "./http.js";
import type { SessionRecord } from "./snapshot.js";
import { StateStore } from "./store.js";
import { watchRepo } from "./watcher.js";

export interface ServeOptions {
  cwd: string;
  port?: number;
  host?: string;
  identity?: GitIdentity;
  sessions?: () => SessionRecord[];
  watch?: boolean;
  /** Built web app to serve at /. */
  webDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  root: string;
  store: StateStore;
  close: () => Promise<void>;
}

/** `sdlc serve`: derive from HEAD, watch the repo, serve HTTP + WebSocket. */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  if (!(await isRepo(opts.cwd))) throw new Error(`${opts.cwd} is not a git repository`);
  const root = await repoRoot(opts.cwd);
  const who = opts.identity ?? (await gitIdentity(root));
  if (!who) throw new Error("no git identity — set user.email before serving");
  const store = new StateStore({ root, identity: who, ...(opts.sessions ? { sessions: opts.sessions } : {}) });
  await store.refresh();
  const app = createApp(store, opts.webDir ? { webDir: opts.webDir } : {});
  const watcher = opts.watch === false ? null : watchRepo(root, () => void store.refresh().catch(() => undefined));
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => app.server.listen(opts.port ?? 0, host, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    root,
    store,
    close: async () => {
      watcher?.close();
      await app.close();
    },
  };
}

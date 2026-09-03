import type { AddressInfo } from "node:net";
import { identity as gitIdentity, isRepo, repoRoot, type GitIdentity } from "@sdlc/adapter-git";
import { Engine, JobStore } from "./engine/index.js";
import { createApp } from "./http.js";
import { enrich, SessionRegistry } from "./sessions/registry.js";
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
  /** Path to the sdlc bin for per-session MCP configs; sessions cannot launch without it. */
  sdlcBin?: string;
  /** Harness executable (default `claude`); tests point it at a fake. */
  claudeBin?: string;
  /** Run the lifecycle engine: launch sessions and per-change runs on transitions. */
  engine?: boolean;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  root: string;
  store: StateStore;
  registry: SessionRegistry;
  engine: Engine | null;
  jobs: JobStore;
  close: () => Promise<void>;
}

/** `sdlc serve`: derive from HEAD, watch the repo, serve HTTP + WebSocket. */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  if (!(await isRepo(opts.cwd))) throw new Error(`${opts.cwd} is not a git repository`);
  const root = await repoRoot(opts.cwd);
  const who = opts.identity ?? (await gitIdentity(root));
  if (!who) throw new Error("no git identity — set user.email before serving");
  const registry = new SessionRegistry(root);
  const sessions = opts.sessions ? () => opts.sessions?.() ?? [] : (repo: import("@sdlc/core").Repo | null) => registry.list().map((s) => enrich(s, repo));
  const store = new StateStore({ root, identity: who, sessions });
  await store.refresh();
  const jobs = new JobStore(registry.database);
  const engine = opts.sdlcBin
    ? new Engine({ store, registry, jobs, sdlcBin: opts.sdlcBin, identity: who, ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}), autoLaunch: opts.engine === true, ...(opts.log ? { log: opts.log } : {}) })
    : null;
  const app = createApp(store, { ...(opts.webDir ? { webDir: opts.webDir } : {}), registry, ...(opts.sdlcBin ? { sdlcBin: opts.sdlcBin } : {}), ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}), ...(engine ? { engine, jobs } : {}) });
  if (engine && opts.engine) void engine.tick();
  const watcher = opts.watch === false ? null : watchRepo(root, () => void store.refresh().catch(() => undefined));
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => app.server.listen(opts.port ?? 0, host, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    root,
    store,
    registry,
    engine,
    jobs,
    close: async () => {
      watcher?.close();
      engine?.close();
      await app.close();
      registry.close();
    },
  };
}

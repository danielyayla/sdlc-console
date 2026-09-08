import type { AddressInfo } from "node:net";
import { identity as gitIdentity, isRepo, repoRoot, type GitIdentity } from "@sdlc/adapter-git";
import { resolveConfig } from "@sdlc/core";
import { Engine, JobStore } from "./engine/index.js";
import { collectSources, FactsCache } from "./metrics/index.js";
import { DeliveryLog } from "./github/webhooks.js";
import { createApp } from "./http.js";
import { enrich, SessionRegistry } from "./sessions/registry.js";
import type { SessionRecord } from "./snapshot.js";
import { StateStore } from "./store.js";
import { watchRepo } from "./watcher.js";
import { Authenticator } from "./auth/index.js";

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
  /** Environment for the code host (`GITHUB_TOKEN`) and the webhook receiver (`GITHUB_WEBHOOK_SECRET`); defaults to the process environment. */
  env?: Record<string, string | undefined>;
  /** Hosted mode: `fetch` for the identity provider (tests point it at a fake) and a clock for session expiry. */
  authFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
}

export interface RunningServer {
  url: string;
  port: number;
  root: string;
  store: StateStore;
  registry: SessionRegistry;
  engine: Engine | null;
  jobs: JobStore;
  /** Webhook deliveries (null without the engine). */
  deliveries: DeliveryLog | null;
  facts: FactsCache;
  /** Hosted mode (3.1): the identity provider the console signs people in with; null in local mode. */
  auth: Authenticator | null;
  close: () => Promise<void>;
}

function loadEmptyConfig(): import("@sdlc/core").ResolvedConfig {
  return resolveConfig(null);
}

/** `sdlc serve`: derive from HEAD, watch the repo, serve HTTP + WebSocket. */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  if (!(await isRepo(opts.cwd))) throw new Error(`${opts.cwd} is not a git repository`);
  const root = await repoRoot(opts.cwd);
  const who = opts.identity ?? (await gitIdentity(root));
  if (!who) throw new Error("no git identity — set user.email before serving");
  const registry = new SessionRegistry(root);
  const sessions = opts.sessions ? () => opts.sessions?.() ?? [] : (repo: import("@sdlc/core").Repo | null) => registry.list().map((s) => enrich(s, repo));
  const facts = new FactsCache(registry.database);
  const store = new StateStore({ root, identity: who, sessions, facts: (repo) => collectSources(repo, facts) });
  await store.refresh();
  const jobs = new JobStore(registry.database);
  const engine = opts.sdlcBin
    ? new Engine({ store, registry, jobs, sdlcBin: opts.sdlcBin, identity: who, ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}), autoLaunch: opts.engine === true, facts, ...(opts.log ? { log: opts.log } : {}), ...(opts.env ? { env: opts.env } : {}) })
    : null;
  const deliveries = engine ? new DeliveryLog(registry.database) : null;
  const authConfig = store.currentRepo?.config.auth ?? null;
  const env = opts.env ?? process.env;
  const auth = authConfig
    ? new Authenticator({ auth: authConfig, config: () => store.currentRepo?.config ?? loadEmptyConfig(), ...(env["SDLC_OIDC_CLIENT_SECRET"] ? { clientSecret: env["SDLC_OIDC_CLIENT_SECRET"] } : {}), ...(opts.authFetch ? { fetch: opts.authFetch } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.log ? { log: opts.log } : {}) })
    : null;
  const app = createApp(store, { ...(opts.webDir ? { webDir: opts.webDir } : {}), registry, ...(opts.sdlcBin ? { sdlcBin: opts.sdlcBin } : {}), ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}), ...(engine ? { engine, jobs } : {}), facts, ...(deliveries ? { deliveries } : {}), ...(opts.env ? { env: opts.env } : {}), ...(auth ? { auth } : {}) });
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
    deliveries,
    facts,
    auth,
    close: async () => {
      watcher?.close();
      engine?.close();
      await app.close();
      registry.close();
    },
  };
}

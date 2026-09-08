import type { AddressInfo } from "node:net";
import { identity as gitIdentity, isRepo, type GitIdentity } from "@sdlc/adapter-git";
import { gitHubCodeHostFrom } from "@sdlc/adapter-github";
import { resolveConfig } from "@sdlc/core";
import { SnapshotCache } from "./cache.js";
import { Engine, JobStore } from "./engine/index.js";
import { collectSources, FactsCache } from "./metrics/index.js";
import { DeliveryLog } from "./github/webhooks.js";
import { createApp, type ProductApp } from "./http.js";
import { resolveProducts, type ProductSpec } from "./products.js";
import { enrich, SessionRegistry } from "./sessions/registry.js";
import type { SessionRecord } from "./snapshot.js";
import { StateStore } from "./store.js";
import { watchRepo } from "./watcher.js";
import { Authenticator } from "./auth/index.js";

export interface ServeOptions {
  cwd: string;
  /** Further repositories to serve alongside `cwd` (multi-repo, 3.2); each contributes its products. */
  repos?: string[];
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
  /** Environment for the code host (`GITHUB_TOKEN` or the `SDLC_GITHUB_APP_*` set) and the webhook receiver (`GITHUB_WEBHOOK_SECRET`); defaults to the process environment. */
  env?: Record<string, string | undefined>;
  /** Hosted mode: `fetch` for the identity provider (tests point it at a fake) and a clock for session expiry. */
  authFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
}

/** Everything the server holds for one product: its own store, cache, queue and engine over its own `sdlc/` home. */
export interface ProductRuntime extends ProductSpec {
  store: StateStore;
  registry: SessionRegistry;
  jobs: JobStore;
  facts: FactsCache;
  engine: Engine | null;
  deliveries: DeliveryLog | null;
  /** The GitHub App's bot user when the product commits on behalf of people; null in token or local mode. */
  committer: GitIdentity | null;
  close: () => void;
}

export interface RunningServer {
  url: string;
  port: number;
  /** The primary product's home (the first product of `cwd`). */
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
  /** Every product served, the primary first (3.2). */
  products: ProductRuntime[];
  close: () => Promise<void>;
}

function loadEmptyConfig(): import("@sdlc/core").ResolvedConfig {
  return resolveConfig(null);
}

async function startProduct(spec: ProductSpec, opts: ServeOptions, who: GitIdentity, env: Record<string, string | undefined>): Promise<ProductRuntime> {
  const registry = new SessionRegistry(spec.home);
  const sessions = opts.sessions ? () => opts.sessions?.() ?? [] : (repo: import("@sdlc/core").Repo | null) => registry.list().map((s) => enrich(s, repo));
  const facts = new FactsCache(registry.database);
  const cache = new SnapshotCache(registry.database);
  // under a GitHub App the console commits on behalf of the person: they author, the App's bot user commits (3.2)
  let committer: GitIdentity | null = null;
  const probe = new StateStore({ root: spec.home, identity: who, product: spec.name });
  await probe.refresh();
  if (probe.currentRepo?.config.codeHost === "github") {
    const host = gitHubCodeHostFrom(env);
    if (host?.auth === "app") committer = await host.appIdentity();
  }
  const store = new StateStore({ root: spec.home, identity: who, product: spec.name, cache, sessions, facts: (repo) => collectSources(repo, facts), ...(committer ? { committer } : {}) });
  await store.refresh();
  const jobs = new JobStore(registry.database);
  const log = opts.log ? (line: string) => opts.log?.(`[${spec.name}] ${line}`) : undefined;
  const engine = opts.sdlcBin
    ? new Engine({ store, registry, jobs, sdlcBin: opts.sdlcBin, identity: who, ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}), autoLaunch: opts.engine === true, facts, ...(log ? { log } : {}), ...(opts.env ? { env: opts.env } : {}) })
    : null;
  const deliveries = engine ? new DeliveryLog(registry.database) : null;
  const watcher = opts.watch === false ? null : watchRepo(spec.home, () => void store.refresh().catch(() => undefined));
  return {
    ...spec,
    store,
    registry,
    jobs,
    facts,
    engine,
    deliveries,
    committer,
    close: () => {
      watcher?.close();
      engine?.close();
      registry.close();
    },
  };
}

/** `sdlc serve`: derive from HEAD, watch the repo, serve HTTP + WebSocket — one store per product (3.2). */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  if (!(await isRepo(opts.cwd))) throw new Error(`${opts.cwd} is not a git repository`);
  const env = opts.env ?? process.env;
  const specs = await resolveProducts(opts.cwd, env, opts.repos ?? []);
  const primarySpec = specs[0];
  if (!primarySpec) throw new Error("nothing to serve");
  const who = opts.identity ?? (await gitIdentity(primarySpec.root));
  if (!who) throw new Error("no git identity — set user.email before serving");
  const products: ProductRuntime[] = [];
  for (const spec of specs) products.push(await startProduct(spec, opts, who, env));
  const primary = products[0] as ProductRuntime;
  const store = primary.store;
  const authConfig = store.currentRepo?.config.auth ?? null;
  const auth = authConfig
    ? new Authenticator({ auth: authConfig, config: () => store.currentRepo?.config ?? loadEmptyConfig(), ...(env["SDLC_OIDC_CLIENT_SECRET"] ? { clientSecret: env["SDLC_OIDC_CLIENT_SECRET"] } : {}), ...(opts.authFetch ? { fetch: opts.authFetch } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.log ? { log: opts.log } : {}) })
    : null;
  const apps: ProductApp[] = products.map((p) => ({ name: p.name, root: p.root, home: p.home, prefix: p.prefix, store: p.store, registry: p.registry, facts: p.facts, jobs: p.jobs, ...(p.engine ? { engine: p.engine } : {}), ...(p.deliveries ? { deliveries: p.deliveries } : {}) }));
  const app = createApp(store, { ...(opts.webDir ? { webDir: opts.webDir } : {}), products: apps, ...(opts.sdlcBin ? { sdlcBin: opts.sdlcBin } : {}), ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}), ...(opts.env ? { env: opts.env } : {}), ...(auth ? { auth } : {}) });
  if (opts.engine) for (const p of products) if (p.engine) void p.engine.tick();
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => app.server.listen(opts.port ?? 0, host, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    root: primary.home,
    store,
    registry: primary.registry,
    engine: primary.engine,
    jobs: primary.jobs,
    deliveries: primary.deliveries,
    facts: primary.facts,
    auth,
    products,
    close: async () => {
      await app.close();
      for (const p of products) p.close();
    },
  };
}

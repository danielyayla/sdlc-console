import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeFor, isRepo, repoRoot } from "@sdlc/adapter-git";
import { startServer, type RunningServer } from "@sdlc/server";
import { CliError, type Io } from "../io.js";
import { actingIdentity } from "../context.js";

export interface ServeOptions {
  port?: number;
  /** Bind address (default 127.0.0.1); GitHub reaches the webhook receiver through a tunnel or a non-loopback host. */
  host?: string;
  role?: "po" | "eng";
  engine?: boolean;
  /** Further repositories to serve alongside the working directory (3.2); each brings its products. */
  repos?: string[];
}

export const DEFAULT_PORT = 7331;

/** The built console next to this package (packages/web/dist), when present. */
export function findWebDir(): string | null {
  for (const rel of ["../../web/dist", "../../../web/dist"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** `sdlc serve --port --role`: prints the URL and keeps running until the process ends. */
export async function serveCommand(io: Io, opts: ServeOptions): Promise<RunningServer> {
  // the server resolves products itself: the home's config.products[] (or the home alone), plus every --repo
  if (!(await isRepo(io.cwd))) throw new CliError(`${io.cwd} is not a git repository — run \`git init\` first`);
  const ctx = { io, root: (await homeFor(io.cwd, io.env)).home, repoRoot: await repoRoot(io.cwd), json: false };
  const who = await actingIdentity(ctx);
  const webDir = findWebDir();
  const repos = (opts.repos ?? []).map((r) => resolve(io.cwd, r));
  const server = await startServer({ cwd: ctx.root, ...(repos.length > 0 ? { repos } : {}), identity: who, port: opts.port ?? DEFAULT_PORT, ...(opts.host ? { host: opts.host } : {}), sdlcBin: fileURLToPath(new URL("../bin.js", import.meta.url)), ...(webDir ? { webDir } : {}), engine: opts.engine === true, env: io.env, log: (line) => io.stderr(`${line}\n`) });
  const hosts = [...new Set(server.products.map((p) => p.store.currentRepo?.config.codeHost ?? "local"))];
  const codeHost = hosts.some((h) => h !== "local") ? `  codeHost: ${hosts.join(", ")}` : "";
  const webhooks = [io.env["GITHUB_WEBHOOK_SECRET"] ? `${server.url}/api/webhooks/github` : "", io.env["SDLC_GITLAB_WEBHOOK_SECRET"] ? `${server.url}/api/webhooks/gitlab` : ""].filter(Boolean).map((u) => `  webhooks: ${u}`).join("");
  const auth = server.auth ? `  auth: oidc via ${server.auth.provider.issuer}${io.env["SDLC_OIDC_CLIENT_SECRET"] ? "" : " (public client, PKCE)"}` : "";
  const github = server.products.some((p) => p.committer) ? `  github: app (commits on behalf of the signed-in person)` : "";
  const products = server.products.length > 1 ? `  products: ${server.products.map((p) => p.name).join(", ")}` : "";
  io.stdout(`${server.url}${webDir ? "" : "  (API only — build @sdlc/web to serve the console)"}${opts.engine ? "  engine: on" : ""}${products}${codeHost}${auth}${github}${webhooks}\n`);
  return server;
}

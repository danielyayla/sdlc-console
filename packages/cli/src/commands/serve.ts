import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@sdlc/server";
import type { Io } from "../io.js";
import { actingIdentity, repoContext } from "../context.js";

export interface ServeOptions {
  port?: number;
  role?: "po" | "eng";
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
  const ctx = await repoContext(io, false);
  const who = await actingIdentity(ctx);
  const webDir = findWebDir();
  const server = await startServer({ cwd: ctx.root, identity: who, port: opts.port ?? DEFAULT_PORT, ...(webDir ? { webDir } : {}) });
  io.stdout(`${server.url}${webDir ? "" : "  (API only — build @sdlc/web to serve the console)"}\n`);
  return server;
}

import { startServer, type RunningServer } from "@sdlc/server";
import type { Io } from "../io.js";
import { actingIdentity, repoContext } from "../context.js";

export interface ServeOptions {
  port?: number;
  role?: "po" | "eng";
}

/** `sdlc serve --port --role`: prints the URL and keeps running until the process ends. */
export async function serveCommand(io: Io, opts: ServeOptions): Promise<RunningServer> {
  const ctx = await repoContext(io, false);
  const who = await actingIdentity(ctx);
  const server = await startServer({ cwd: ctx.root, identity: who, ...(opts.port !== undefined ? { port: opts.port } : {}) });
  io.stdout(`${server.url}\n`);
  return server;
}

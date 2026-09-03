import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSdlcServer, type ServerOptions } from "./tools.js";

/** `sdlc mcp`: serve the agent tools over stdio for the harness. */
export async function serveStdio(opts: ServerOptions): Promise<() => Promise<void>> {
  const server = createSdlcServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return () => server.close();
}

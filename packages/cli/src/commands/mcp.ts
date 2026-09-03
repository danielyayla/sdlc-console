import { serveStdio } from "@sdlc/mcp";
import type { Io } from "../io.js";

/** `sdlc mcp`: agent tools over stdio; runs until the harness closes the pipe. */
export async function mcpCommand(io: Io): Promise<number> {
  const close = await serveStdio({ cwd: io.cwd, env: io.env });
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await close();
  return 0;
}

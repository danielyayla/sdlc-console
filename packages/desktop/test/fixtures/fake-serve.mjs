#!/usr/bin/env node
// Stands in for `sdlc serve` (the CLI bin): prints the URL line the way serveCommand does and stays up until SIGTERM.
// FAKE_SERVE_DIE=1 exits 3 without a URL; FAKE_SERVE_SILENT=1 never prints one.
const args = process.argv.slice(2);
const port = args[args.indexOf("--port") + 1];
if (process.env.FAKE_SERVE_DIE) {
  process.stderr.write("boom\n");
  process.exit(3);
}
if (!process.env.FAKE_SERVE_SILENT) process.stdout.write(`http://127.0.0.1:${port}${args.includes("--engine") ? "  engine: on" : ""}\n`);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);

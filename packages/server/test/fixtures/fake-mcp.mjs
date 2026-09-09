#!/usr/bin/env node
// Stand-in for `sdlc mcp` in harness tests (3.8): a newline-delimited JSON-RPC MCP server over
// stdio with one tool, report_round, that writes the round where the real tool does —
// `.sdlc-state/sessions/<SDLC_SESSION>/rounds.jsonl` under the working directory. The real
// tools are tested in @sdlc/mcp; this fixture exists because a test cannot spawn the real
// server from TypeScript source.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const session = process.env.SDLC_SESSION ?? "unknown";
const dir = join(process.cwd(), ".sdlc-state", "sessions", session);
const file = join(dir, "rounds.jsonl");

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
    nl = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  if (msg.method === "initialize") return reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-sdlc-mcp", version: "0" } });
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") return reply(msg.id, { tools: [{ name: "report_round", description: "record one round", inputSchema: { type: "object" } }] });
  if (msg.method === "tools/call" && msg.params?.name === "report_round") {
    const previous = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
    const round = { n: previous + 1, ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), results: msg.params.arguments.results, dirtyHash: "0" };
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(round)}\n`);
    const value = { n: round.n, loopState: round.results.every((r) => r.pass) ? "green" : "iterating" };
    return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  }
  if (msg.id !== undefined) fail(msg.id, `unsupported: ${msg.method}`);
}

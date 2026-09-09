#!/usr/bin/env node
// Fake CLI agent for the `command` harness (3.8): any agent the console only starts.
// It records what it was handed (argv, the SDLC_* env, its cwd), speaks MCP over stdio
// to the server named in SDLC_MCP_CONFIG just enough to report one round, and exits 0.
// FAKE_AGENT_ROUND=green|red|none picks the round; FAKE_AGENT_ARGS=<file> records the handover.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
const record = env.FAKE_AGENT_ARGS;
const promptFile = env.SDLC_PROMPT_FILE;
if (record) {
  const keys = Object.keys(env).filter((k) => k.startsWith("SDLC_") || k.startsWith("GIT_AUTHOR") || k.startsWith("FAKE_AGENT_WORKTREE"));
  const picked = Object.fromEntries(keys.sort().map((k) => [k, env[k]]));
  writeFileSync(record, `${JSON.stringify({ args, env: picked, cwd: process.cwd(), promptHead: promptFile ? readFileSync(promptFile, "utf8").split("\n")[0] : null }, null, 2)}\n`);
}
process.stdout.write("fake agent: starting\n");

const round = env.FAKE_AGENT_ROUND ?? "green";
if (round !== "none") {
  const cfg = JSON.parse(readFileSync(env.SDLC_MCP_CONFIG, "utf8")).mcpServers.sdlc;
  const server = spawn(cfg.command, cfg.args, { env: { ...env, ...(cfg.env ?? {}) }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
      nl = buffer.indexOf("\n");
    }
  });
  let next = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-agent", version: "0" } });
  notify("notifications/initialized", {});
  const results = [
    { name: "build", pass: true, exitCode: 0, outputExcerpt: "tsc -b: ok" },
    { name: "test", pass: round === "green", exitCode: round === "green" ? 0 : 1, outputExcerpt: round === "green" ? "Tests 45 passed (45)" : "Tests 1 failed | 44 passed (45)" },
  ];
  const reply = await call("tools/call", { name: "report_round", arguments: { sessionId: env.SDLC_SESSION, results } });
  process.stdout.write(`fake agent: reported round → ${JSON.stringify(reply.result?.structuredContent ?? reply.error)}\n`);
  server.stdin.end();
  await new Promise((resolve) => server.on("exit", resolve));
}
process.stdout.write("fake agent: done\n");
process.exit(0);

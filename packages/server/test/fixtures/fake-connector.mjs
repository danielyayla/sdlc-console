#!/usr/bin/env node
// A records connector for tests (FR-16): an MCP server over stdio with the two
// tools the console calls. FAKE_CONNECTOR_LOG receives one JSON line per call;
// FAKE_CONNECTOR_FAIL=1 makes record_write_back answer a tool error;
// FAKE_CONNECTOR_UNKNOWN=<id> makes record_get answer "not found" for that id.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (entry) => {
  if (process.env.FAKE_CONNECTOR_LOG) appendFileSync(process.env.FAKE_CONNECTOR_LOG, `${JSON.stringify(entry)}\n`);
};

const server = new McpServer({ name: "fake-records", version: "0.0.0" });

server.registerTool(
  "record_get",
  { description: "Look up a record", inputSchema: { system: z.string(), id: z.string() } },
  async ({ system, id }) => {
    log({ tool: "record_get", system, id });
    if (process.env.FAKE_CONNECTOR_UNKNOWN === id) return { isError: true, content: [{ type: "text", text: `${system} has no record ${id}` }] };
    const body = { id, url: `https://records.example/${system}/${id}`, title: `Record ${id}`, status: "open" };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  },
);

server.registerTool(
  "record_write_back",
  {
    description: "Write an artifact fact to a record",
    inputSchema: { system: z.string(), id: z.string(), changeId: z.string(), title: z.string(), artifact: z.number(), artifactName: z.string(), kind: z.string(), sha: z.string(), by: z.string(), at: z.string(), url: z.string().optional() },
  },
  async (args) => {
    log({ tool: "record_write_back", ...args });
    if (process.env.FAKE_CONNECTOR_FAIL === "1") return { isError: true, content: [{ type: "text", text: "connector unavailable (503 from the records API)" }] };
    const body = { ok: true, url: `https://records.example/${args.system}/${args.id}#${args.kind}-${args.sha.slice(0, 7)}` };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  },
);

await server.connect(new StdioServerTransport());

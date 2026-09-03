import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { WritebackKind } from "@sdlc/schemas";

/**
 * Records connector (FR-16, blueprint §7.12): the platform team's MCP server
 * that fronts Jira / ServiceNow / the requirements tool. The console is its
 * client — one short-lived stdio process per call — and never reaches the
 * external system any other way. `records.connector` in `sdlc/config.yaml`
 * names the entry under `mcpServers` in the project's `.mcp.json` (the file
 * Claude Code reads; the console parses it, never edits it).
 *
 * Tool contract the connector implements:
 *   record_get        {system, id}                      → {id, url?, title?, status?}
 *   record_write_back {system, id, changeId, title, artifact, artifactName, kind, sha, by, at, url?}
 *                                                       → {ok: true, url?}   (a tool error = the write-back failed)
 */

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | undefined;
}

export interface RecordInfo {
  id: string;
  url?: string;
  title?: string;
  status?: string;
}

export interface WritebackPayload {
  system: string;
  id: string;
  changeId: string;
  title: string;
  artifact: number;
  artifactName: string;
  kind: WritebackKind;
  sha: string;
  /** Who decided (the accepting human) or committed (the agent / session). */
  by: string;
  at: string;
  url?: string;
}

export interface RecordsConnector {
  readonly name: string;
  get(system: string, id: string): Promise<RecordInfo>;
  writeBack(payload: WritebackPayload): Promise<{ url?: string }>;
}

interface McpJson {
  mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: unknown; cwd?: unknown }>;
}

/** The `.mcp.json` entry for `records.connector`; null when the config names none. Throws (non-retryable) when the name resolves to nothing. */
export function connectorSpec(root: string, name: string | undefined | null): ConnectorSpec | null {
  if (!name) return null;
  let parsed: McpJson;
  try {
    parsed = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as McpJson;
  } catch (e) {
    throw new ConnectorError(`records.connector is "${name}" but .mcp.json cannot be read: ${(e as Error).message}`, false);
  }
  const entry = parsed.mcpServers?.[name];
  if (!entry || typeof entry.command !== "string" || entry.command.trim() === "") throw new ConnectorError(`records.connector is "${name}" but .mcp.json has no mcpServers.${name} with a command`, false);
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  const env: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object") for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) if (typeof v === "string") env[k] = v;
  return { name, command: entry.command, args, env, cwd: typeof entry.cwd === "string" ? entry.cwd : undefined };
}

function textOf(result: { content?: unknown; structuredContent?: unknown }): string {
  const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function payloadOf(result: { content?: unknown; structuredContent?: unknown }): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, unknown>;
  const text = textOf(result);
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A connector over the MCP stdio transport: spawn, call one tool, close. */
export function mcpConnector(spec: ConnectorSpec, timeoutMs = 30_000): RecordsConnector {
  async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...getDefaultEnvironment(), ...spec.env }, ...(spec.cwd ? { cwd: spec.cwd } : {}), stderr: "ignore" });
    const client = new Client({ name: "sdlc-console", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (e) {
      throw new ConnectorError(`connector ${spec.name} (${spec.command}) did not start: ${(e as Error).message}`);
    }
    try {
      const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs })) as { isError?: boolean; content?: unknown; structuredContent?: unknown };
      if (result.isError) throw new ConnectorError(`${tool} on ${spec.name}: ${textOf(result) || "the connector reported an error"}`);
      return payloadOf(result);
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError(`${tool} on ${spec.name} failed: ${(e as Error).message}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  return {
    name: spec.name,
    async get(system, id) {
      const r = await call("record_get", { system, id });
      const found = typeof r["id"] === "string" ? r["id"] : id;
      return {
        id: found,
        ...(typeof r["url"] === "string" ? { url: r["url"] } : {}),
        ...(typeof r["title"] === "string" ? { title: r["title"] } : {}),
        ...(typeof r["status"] === "string" ? { status: r["status"] } : {}),
      };
    },
    async writeBack(payload) {
      const r = await call("record_write_back", { ...payload });
      if (r["ok"] === false) throw new ConnectorError(`record_write_back on ${spec.name}: ${typeof r["error"] === "string" ? r["error"] : "refused"}`);
      return typeof r["url"] === "string" ? { url: r["url"] } : {};
    },
  };
}

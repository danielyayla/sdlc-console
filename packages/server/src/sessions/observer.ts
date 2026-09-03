import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SessionRegistry } from "./registry.js";

export interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
  [key: string]: unknown;
}

export interface ObserveOptions {
  transcriptPath: string;
  now?: () => Date;
  onExit?: (code: number | null, record: { status: string }) => Promise<void> | void;
}

/** Follow a headless Claude Code session's stream-json output into the registry and a transcript file. */
export function observe(child: ChildProcess, registry: SessionRegistry, sessionId: string, opts: ObserveOptions): Promise<number | null> {
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  const now = () => (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  let buffer = "";
  let sawResult = false;
  let isError = false;
  let stderr = "";
  const handle = (line: string) => {
    if (line.trim() === "") return;
    appendFileSync(opts.transcriptPath, `${line}\n`, "utf8");
    const msg: StreamLine | null = (() => {
      try {
        return JSON.parse(line) as StreamLine;
      } catch {
        return null;
      }
    })();
    const patch: Record<string, unknown> = { heartbeatAt: now(), lastLine: line.slice(0, 200) };
    if (msg?.type === "system" && msg.subtype === "init") {
      if (typeof msg.model === "string") patch["modelPin"] = msg.model;
      if (typeof msg.session_id === "string") patch["harnessSessionId"] = msg.session_id;
    }
    if (msg?.type === "result") {
      sawResult = true;
      isError = msg.is_error === true;
      if (typeof msg.total_cost_usd === "number") patch["costUsd"] = msg.total_cost_usd;
      if (typeof msg.num_turns === "number") patch["numTurns"] = msg.num_turns;
      if (isError && typeof msg.result === "string") patch["error"] = msg.result.slice(0, 500);
    }
    registry.patch(sessionId, patch);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      if (buffer.trim() !== "") handle(buffer);
      const current = registry.get(sessionId);
      const taken = current?.status === "taken_over" || current?.status === "stopped";
      const status = taken ? current.status : code === 0 && sawResult && !isError ? "done" : "error";
      registry.patch(sessionId, { status, exitCode: code, pid: null, heartbeatAt: now(), ...(status === "error" && !current?.error ? { error: stderr.trim().slice(-500) || `harness exited with code ${code}` } : {}) });
      void Promise.resolve(opts.onExit?.(code, { status })).finally(() => resolve(code));
    });
  });
}

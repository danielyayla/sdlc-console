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
  /** `stream-json` (Claude Code: init/result lines drive model, cost and the done verdict) or `text` (any other harness: lines kept verbatim, exit 0 = done). */
  output?: "stream-json" | "text";
  now?: () => Date;
  /** Last word on the status once the process exited (3.8): a stand-in for a Stop hook the harness lacks may turn `done` into `done-unverified`. */
  finalStatus?: (status: string) => { status: string; patch?: Record<string, unknown> };
  onExit?: (code: number | null, record: { status: string }) => Promise<void> | void;
}

/** Follow a headless session's output into the registry and a transcript file: Claude Code's stream-json parsed, any other harness's lines verbatim. */
export function observe(child: ChildProcess, registry: SessionRegistry, sessionId: string, opts: ObserveOptions): Promise<number | null> {
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  const now = () => (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const structured = (opts.output ?? "stream-json") === "stream-json";
  let buffer = "";
  let sawResult = false;
  let isError = false;
  let stderr = "";
  const handle = (line: string) => {
    if (line.trim() === "") return;
    try {
      appendFileSync(opts.transcriptPath, `${line}\n`, "utf8");
    } catch {
      // the cache directory is disposable: a transcript whose directory went away is not worth the session
    }
    const msg: StreamLine | null = (() => {
      if (!structured) return null;
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
      const taken = current?.status === "taken_over" || current?.status === "stopped" || current?.status === "awaiting_engineer";
      const exited = taken ? current.status : code === 0 && (structured ? sawResult && !isError : true) ? "done" : "error";
      const final = taken ? { status: exited } : (opts.finalStatus?.(exited) ?? { status: exited });
      const status = final.status;
      registry.patch(sessionId, { status: status as never, exitCode: code, pid: null, heartbeatAt: now(), ...(final.patch ?? {}), ...(status === "error" && !current?.error ? { error: stderr.trim().slice(-500) || `harness exited with code ${code}` } : {}) });
      void Promise.resolve(opts.onExit?.(code, { status })).finally(() => resolve(code));
    });
  });
}

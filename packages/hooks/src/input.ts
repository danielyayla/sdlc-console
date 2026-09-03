/** The JSON Claude Code pipes to a hook on stdin (fields we use; unknown keys ignored). */
export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  transcript_path?: string;
}

export function parseHookInput(text: string, fallbackCwd: string): HookInput {
  const raw: unknown = (() => {
    try {
      return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch {
      return {};
    }
  })();
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const str = (k: string, d = "") => (typeof o[k] === "string" ? (o[k] as string) : d);
  const input: HookInput = {
    session_id: str("session_id", "unknown-session"),
    cwd: str("cwd", fallbackCwd) || fallbackCwd,
    hook_event_name: str("hook_event_name"),
    stop_hook_active: o["stop_hook_active"] === true,
  };
  if (typeof o["tool_name"] === "string") input.tool_name = o["tool_name"];
  if (typeof o["tool_input"] === "object" && o["tool_input"] !== null) input.tool_input = o["tool_input"] as Record<string, unknown>;
  if (typeof o["transcript_path"] === "string") input.transcript_path = o["transcript_path"];
  return input;
}

export function toolFilePath(input: HookInput): string | null {
  const p = input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"];
  return typeof p === "string" ? p : null;
}

export function toolCommand(input: HookInput): string | null {
  const c = input.tool_input?.["command"];
  return typeof c === "string" ? c : null;
}

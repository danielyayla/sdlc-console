import { HOOK_NAMES, parseHookInput, runHook, type HookName } from "@sdlc/hooks";
import type { Io } from "../io.js";

/** `sdlc hook <name>`: harness JSON on stdin → exit 0 (allow) or 2 (block, message on stderr). */
export async function hookCommand(io: Io, name: string): Promise<number> {
  if (!(HOOK_NAMES as readonly string[]).includes(name)) {
    io.stderr(`unknown hook ${name}; expected one of ${HOOK_NAMES.join(", ")}\n`);
    return 1;
  }
  const input = parseHookInput(await io.stdin(), io.cwd, io.env);
  const r = await runHook(name as HookName, input, { env: io.env });
  if (r.error) io.stderr(`${r.reason}\n`);
  if (!r.allowed) io.stderr(`${r.reason}\n`);
  return r.exitCode;
}

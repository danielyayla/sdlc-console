import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newUlid } from "@sdlc/adapter-git";
import { logPath } from "@sdlc/core";
import { stringifyJsonl, type Event, type EventName, type EventOf } from "@sdlc/schemas";

function nextSeq(abs: string): number {
  if (!existsSync(abs)) return 1;
  let max = 0;
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    const m = /"seq":\s*(\d+)/.exec(line);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Append an agent-authored event to the working-tree ledger of the change the
 * hook is acting on. It rides along with the next commit (merge=union keeps
 * branches from conflicting).
 */
export function appendHookEvent<N extends EventName>(root: string, changeId: string, cycle: number, session: string, name: N, data: EventOf<N>["data"], now = new Date()): Event {
  const abs = join(root, logPath(changeId));
  mkdirSync(dirname(abs), { recursive: true });
  const event = {
    schema: 1,
    id: newUlid(now.getTime()),
    ts: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    seq: nextSeq(abs),
    cycle,
    actor: { type: "agent", id: "claude-code", session },
    event: name,
    data,
  } as unknown as Event;
  appendFileSync(abs, stringifyJsonl([event]), "utf8");
  return event;
}

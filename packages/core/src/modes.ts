import type { SessionMode } from "@sdlc/schemas";

/** Autonomy order (P9): a human may only move a session down this ladder. */
export const MODE_RANK: Record<SessionMode, number> = { PLAN: 0, SUPERVISED: 1, HEADLESS: 2, AUTO: 3 };

export function isDowngrade(from: SessionMode, to: SessionMode): boolean {
  return MODE_RANK[to] < MODE_RANK[from];
}

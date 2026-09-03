import type { Event, EventName, EventOf } from "@sdlc/schemas";

/** Sort by seq, then timestamp, then id — stable across branches (union merge). */
export function sortEvents(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
}

/** De-duplicate by event id (union merges can replay lines). */
export function dedupeEvents(events: readonly Event[]): Event[] {
  const seen = new Set<string>();
  const out: Event[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function eventsOfCycle(events: readonly Event[], cycle: number): Event[] {
  return events.filter((e) => e.cycle === cycle);
}

export function isEvent<N extends EventName>(e: Event, name: N): e is EventOf<N> {
  return e.event === name;
}

export function lastEvent<N extends EventName>(
  events: readonly Event[],
  name: N,
  where?: (e: EventOf<N>) => boolean,
): EventOf<N> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && isEvent(e, name) && (!where || where(e))) return e;
  }
  return null;
}

export function firstEvent<N extends EventName>(
  events: readonly Event[],
  name: N,
  where?: (e: EventOf<N>) => boolean,
): EventOf<N> | null {
  for (const e of events) {
    if (isEvent(e, name) && (!where || where(e))) return e;
  }
  return null;
}

export function eventsNamed<N extends EventName>(events: readonly Event[], name: N): EventOf<N>[] {
  return events.filter((e): e is EventOf<N> => e.event === name);
}

/** Position of an event in an ordered list; -1 when absent. */
export function indexOf(events: readonly Event[], e: Event | null): number {
  return e ? events.findIndex((x) => x.id === e.id) : -1;
}

/** The latest of several candidate events by order in the list. */
export function latestOf(events: readonly Event[], candidates: readonly (Event | null)[]): Event | null {
  let best: Event | null = null;
  let bestIdx = -1;
  for (const c of candidates) {
    const idx = indexOf(events, c);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = c;
    }
  }
  return best;
}

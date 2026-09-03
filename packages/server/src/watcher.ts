import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface Watcher {
  close: () => void;
}

const WATCHED = [".git/HEAD", ".git/refs", ".git/packed-refs", "sdlc", "evals", ".claude", "CLAUDE.md", "REVIEW.md", "bands.yaml"];

/** Debounced filesystem watcher over the repo paths the console derives from. */
export function watchRepo(root: string, onChange: () => void, debounceMs = 150): Watcher {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  for (const rel of WATCHED) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      watchers.push(watch(abs, { recursive: true, persistent: false }, trigger));
    } catch {
      try {
        watchers.push(watch(abs, { persistent: false }, trigger));
      } catch {
        // unwatchable path (permissions); the next action refreshes anyway
      }
    }
  }
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}

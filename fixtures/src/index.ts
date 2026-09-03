/**
 * @sdlc/fixtures — fixture repositories reproducing the design spec's seed.
 * `fixtures/seed/` on disk is the generated output; the sync test keeps it honest.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blobSha } from "@sdlc/adapter-git";
import type { Tree, TreeFile } from "@sdlc/core";
import { seedFiles } from "./seed.js";

export * from "./seed.js";

/** In-memory Tree of the seed with git-compatible blob shas. */
export function seedTree(): Tree {
  const files = new Map<string, TreeFile>();
  for (const [path, content] of Object.entries(seedFiles())) files.set(path, { content, sha: blobSha(content) });
  return { ref: null, files };
}

/** Write the seed into a directory (a fresh repo, a temp dir, or `fixtures/seed`). */
export function writeSeed(dir: string): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(seedFiles())) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  return written.sort();
}

/** Absolute path of the committed seed directory. */
export function seedDir(): string {
  return fileURLToPath(new URL("../seed/", import.meta.url));
}

export interface SeedSession {
  id: string;
  worktree: string;
  branch: string;
  changeId: string;
  taskId: string | null;
  mode: "AUTO" | "PLAN" | "SUPERVISED" | "HEADLESS";
  engineer: string | null;
  startedAt: string;
  heartbeatAt: string;
  status: string;
  target: string | null;
  [key: string]: unknown;
}

/** The four seed sessions (runtime cache data, not part of the repo tree). */
export function seedSessions(): SeedSession[] {
  const path = fileURLToPath(new URL("../sessions.seed.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as SeedSession[];
}

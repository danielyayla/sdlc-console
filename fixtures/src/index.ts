/**
 * @sdlc/fixtures — fixture repositories reproducing the design spec's seed.
 * `fixtures/seed/` on disk is the generated output; the sync test keeps it honest.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blobSha, git } from "@sdlc/adapter-git";
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

/** Maintain intake envelopes (3.5) under `fixtures/payloads/`: what a Claude Security run and a Claude Tag message deliver. */
export type IntakePayloadName = "claude-security" | "claude-security-update" | "claude-security-resolved" | "claude-tag";

export function payloadPath(name: IntakePayloadName): string {
  return fileURLToPath(new URL(`../payloads/${name}.json`, import.meta.url));
}

export function intakePayload<T = Record<string, unknown>>(name: IntakePayloadName): T {
  return JSON.parse(readFileSync(payloadPath(name), "utf8")) as T;
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

/** The seed's placeholder repro sha for CHG-0018 (a fix whose repro test is "committed"). */
export const SEED_REPRO_SHA = "e4a6f2d5a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5";

/**
 * The seed carries no code, so its repro sha is a placeholder no clone has.
 * Commit the repro test alone on the task-branch worktree and point
 * `change.yaml` and `evals/repro.json` on the default branch at that commit,
 * so the repro proof (2.7) holds for the seed's fix. Returns the sha.
 */
export async function realizeSeedRepro(root: string, worktree: string, changeId = "CHG-0018", testPath = "test/export/zero-total.test.ts"): Promise<string> {
  mkdirSync(dirname(join(worktree, testPath)), { recursive: true });
  writeFileSync(join(worktree, testPath), "it('exports zero-total rows', () => { expect(rows).toHaveLength(4); });\n", "utf8");
  await git(worktree, ["add", "--", testPath]);
  await git(worktree, ["commit", "-q", "-m", `sdlc(${changeId}): repro test ${testPath}`, "--", testPath]);
  const sha = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  for (const rel of [`sdlc/changes/${changeId}/change.yaml`, `sdlc/changes/${changeId}/evals/repro.json`]) {
    const abs = join(root, rel);
    writeFileSync(abs, readFileSync(abs, "utf8").split(SEED_REPRO_SHA).join(sha), "utf8");
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", `sdlc(${changeId}): repro sha`]);
  return sha;
}

/**
 * A monorepo seed (3.2): the seed at the root (product `invoicing`, path `.`)
 * plus the same seed under each nested product path with its own `sdlc/`
 * home, and the root `sdlc/config.yaml` listing every product. Nothing is
 * committed; the caller commits.
 */
export function writeMonorepoSeed(dir: string, nested: { name: string; path: string }[] = [{ name: "billing", path: "apps/billing" }]): void {
  writeSeed(dir);
  const marker = "products:\n  - name: invoicing\n    path: .\n";
  const rewrite = (home: string, block: string) => {
    const cfg = join(home, "sdlc", "config.yaml");
    const text = readFileSync(cfg, "utf8");
    if (!text.includes(marker)) throw new Error("seed config changed: products block not found");
    writeFileSync(cfg, text.replace(marker, block));
  };
  for (const p of nested) {
    writeSeed(join(dir, p.path));
    // a nested home's own config names itself
    rewrite(join(dir, p.path), `products:\n  - name: ${p.name}\n    path: .\n`);
  }
  rewrite(dir, `${marker}${nested.map((p) => `  - name: ${p.name}\n    path: ${p.path}\n`).join("")}`);
}

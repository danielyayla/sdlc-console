import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Tree, TreeFile } from "@sdlc/core";
import { git, gitRaw } from "./git.js";
import { blobSha } from "./sha.js";

/** What the console reads; everything else in the repo is left alone. */
export const DEFAULT_PREFIXES = ["sdlc", "evals", ".claude", "CLAUDE.md", "REVIEW.md", "bands.yaml", ".gitattributes"] as const;

const BINARY = /\.(png|jpe?g|gif|webp|pdf|zip|gz|ico|woff2?)$/i;

export interface ReadTreeOptions {
  prefixes?: readonly string[];
}

/** Snapshot of the committed tree at `ref` (default HEAD). Blob shas are git's. */
export async function readTree(dir: string, ref = "HEAD", opts: ReadTreeOptions = {}): Promise<Tree> {
  const prefixes = [...(opts.prefixes ?? DEFAULT_PREFIXES)];
  const commit = (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  const listing = await gitRaw(dir, ["ls-tree", "-r", "-z", "--format=%(objectname) %(path)", commit, "--", ...prefixes]);
  const files = new Map<string, TreeFile>();
  if (listing.code !== 0) return { ref: commit, files };
  const entries = listing.stdout.split("\0").filter(Boolean).map((line) => {
    const space = line.indexOf(" ");
    return { sha: line.slice(0, space), path: line.slice(space + 1) };
  });
  const wanted = entries.filter((e) => !BINARY.test(e.path));
  for (const e of entries.filter((x) => BINARY.test(x.path))) files.set(e.path, { content: "", sha: e.sha });
  if (wanted.length === 0) return { ref: commit, files };

  const batch = await gitRaw(dir, ["cat-file", "--batch"], { input: wanted.map((e) => e.sha).join("\n") + "\n", binary: true });
  const buf = batch.buffer;
  let pos = 0;
  for (const e of wanted) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    const parts = header.split(" ");
    if (parts[1] === "missing" || parts.length < 3) continue;
    const size = Number(parts[2]);
    const content = buf.subarray(pos, pos + size).toString("utf8");
    pos += size + 1; // trailing newline after each object
    files.set(e.path, { content, sha: e.sha });
  }
  return { ref: commit, files };
}

/** Snapshot of the working directory (uncommitted state) with git-compatible blob shas. */
export function readWorkingTree(dir: string, opts: ReadTreeOptions = {}): Tree {
  const prefixes = [...(opts.prefixes ?? DEFAULT_PREFIXES)];
  const files = new Map<string, TreeFile>();
  const walk = (abs: string) => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (abs.endsWith("/.git") || abs.endsWith("/node_modules")) return;
      for (const name of readdirSync(abs)) walk(join(abs, name));
      return;
    }
    const rel = relative(dir, abs).split("\\").join("/");
    if (BINARY.test(rel)) {
      files.set(rel, { content: "", sha: blobSha(readFileSync(abs)) });
      return;
    }
    const content = readFileSync(abs, "utf8");
    files.set(rel, { content, sha: blobSha(content) });
  };
  for (const p of prefixes) walk(join(dir, p));
  return { ref: null, files };
}

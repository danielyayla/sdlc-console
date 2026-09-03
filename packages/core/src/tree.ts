/** One file in a snapshot. `sha` is the git blob sha when read by the git adapter. */
export interface TreeFile {
  readonly content: string;
  readonly sha: string;
}

/**
 * A read-only snapshot of a repository at one ref. Core only ever computes
 * over this; adapters build it from git or the filesystem.
 */
export interface Tree {
  /** Commit or tree ref the snapshot was read at; null for synthetic trees. */
  readonly ref: string | null;
  readonly files: ReadonlyMap<string, TreeFile>;
}

export const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * Deterministic 40-hex digest for synthetic trees (tests, fixtures built in
 * memory). Not a git sha; the git adapter supplies real blob shas.
 */
export function syntheticSha(content: string): string {
  let out = "";
  for (let round = 0; round < 5; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

export function treeFromRecord(files: Record<string, string>, ref: string | null = null): Tree {
  const map = new Map<string, TreeFile>();
  for (const [path, content] of Object.entries(files)) {
    map.set(normalizePath(path), { content, sha: syntheticSha(content) });
  }
  return { ref, files: map };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function readFile(tree: Tree, path: string): TreeFile | undefined {
  return tree.files.get(normalizePath(path));
}

export function hasFile(tree: Tree, path: string): boolean {
  return tree.files.has(normalizePath(path));
}

/** Paths under a directory prefix (recursive), sorted. */
export function filesUnder(tree: Tree, dir: string): string[] {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return [...tree.files.keys()].filter((p) => p.startsWith(prefix)).sort();
}

/** Immediate child directory names under a prefix, sorted. */
export function childDirs(tree: Tree, dir: string): string[] {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const names = new Set<string>();
  for (const p of tree.files.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) names.add(rest.slice(0, slash));
  }
  return [...names].sort();
}

/** Return a new tree with files added/replaced (content only; sha recomputed synthetically). */
export function withFiles(tree: Tree, files: Record<string, string>): Tree {
  const map = new Map(tree.files);
  for (const [path, content] of Object.entries(files)) {
    map.set(normalizePath(path), { content, sha: syntheticSha(content) });
  }
  return { ref: tree.ref, files: map };
}

import { compileGlobs } from "@sdlc/schemas";
import type { Tree } from "@sdlc/core";

export interface CodeownersRule {
  pattern: string;
  owners: string[];
  line: number;
}

export const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"] as const;

/** Parse CODEOWNERS: `pattern owner…` per line, `#` comments; later rules take precedence. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) return;
    rules.push({ pattern, owners, line: i + 1 });
  });
  return rules;
}

/** gitignore-style CODEOWNERS pattern → picomatch globs. */
export function codeownersGlobs(pattern: string): string[] {
  let p = pattern;
  const leadingSlash = p.startsWith("/");
  if (leadingSlash) p = p.slice(1);
  const trailingSlash = p.endsWith("/");
  if (trailingSlash) p = p.slice(0, -1);
  // gitignore rule: a slash anywhere but the end anchors the pattern to the root
  const anchored = leadingSlash || p.includes("/");
  const globs = trailingSlash ? [`${p}/**`] : [p];
  if (!trailingSlash && !p.includes("*") && !p.includes("?")) globs.push(`${p}/**`);
  return anchored ? globs : globs.map((g) => `**/${g}`);
}

export function ownersFor(rules: readonly CodeownersRule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (compileGlobs(codeownersGlobs(rule.pattern))(path)) owners = rule.owners;
  }
  return owners;
}

/** The first CODEOWNERS file GitHub would use, read from the tree snapshot. */
export function codeownersFromTree(tree: Tree): { path: string; rules: CodeownersRule[] } | null {
  for (const path of CODEOWNERS_PATHS) {
    const file = tree.files.get(path);
    if (file) return { path, rules: parseCodeowners(file.content) };
  }
  return null;
}

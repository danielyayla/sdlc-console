import { basename, resolve } from "node:path";
import { homeFor, isRepo, readTree, showPrefix } from "@sdlc/adapter-git";
import { loadRepo } from "@sdlc/core";

/** One product the server holds a store for: a repository, or a product directory of a monorepo with its own `sdlc/` home (3.2). */
export interface ProductSpec {
  name: string;
  /** Repository top level. */
  root: string;
  /** The SDLC home (holds `sdlc/`, the product's `CLAUDE.md`, `.claude/`, `REVIEW.md`, `bands.yaml`). */
  home: string;
  /** `home` relative to `root` with a trailing slash; empty when the home is the root. */
  prefix: string;
}

/**
 * The products behind `sdlc serve`: for each repository (the working
 * directory plus `--repo` roots) the home's `config.products[]` — every
 * entry's `path` is an SDLC home of its own — or, without any, the home
 * itself named after the repository directory. Names must be unique across
 * repositories; a single-product repository needs no config to be served.
 */
export async function resolveProducts(cwd: string, env: Record<string, string | undefined> = {}, repos: string[] = []): Promise<ProductSpec[]> {
  const out: ProductSpec[] = [];
  const seen = new Set<string>();
  for (const dir of [cwd, ...repos]) {
    if (!(await isRepo(dir))) throw new Error(`${dir} is not a git repository`);
    const base = await homeFor(dir, env);
    const repo = loadRepo(await readTree(base.home, "HEAD").catch(() => ({ ref: null, files: new Map() })));
    const listed = repo.rawConfig?.products ?? [];
    const specs: ProductSpec[] = [];
    for (const p of listed) {
      const home = resolve(base.home, p.path);
      const prefix = await showPrefix(home).catch(() => null);
      if (prefix === null) throw new Error(`product ${p.name}: ${home} is not inside ${base.root}`);
      specs.push({ name: p.name, root: base.root, home, prefix });
    }
    if (specs.length === 0) specs.push({ name: basename(base.home), root: base.root, home: base.home, prefix: base.prefix });
    for (const s of specs) {
      if (seen.has(s.home)) continue;
      if (out.some((o) => o.name === s.name)) throw new Error(`two products are named ${s.name} (${out.find((o) => o.name === s.name)?.home} and ${s.home}); product names must be unique across the repositories served`);
      seen.add(s.home);
      out.push(s);
    }
  }
  return out;
}

/** A product by `--product` / `SDLC_PRODUCT`, or the only one; null when the choice is ambiguous. */
export function pickProduct(products: readonly ProductSpec[], name: string | undefined): ProductSpec | null {
  if (name) return products.find((p) => p.name === name) ?? null;
  return products.length === 1 ? (products[0] ?? null) : null;
}

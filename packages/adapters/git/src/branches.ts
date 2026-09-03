import { dedupeEvents, logPath, sortEvents, type Tree, type TreeFile } from "@sdlc/core";
import { parseJsonl, stringifyJsonl, type Event } from "@sdlc/schemas";
import { gitRaw, isAncestor, localBranches } from "./git.js";
import { readTree, type ReadTreeOptions } from "./tree.js";

export const ARTIFACT_BRANCH = /^sdlc\/(CHG-\d{4})\/(intent|spec|plan|incident)$/;

export interface ArtifactBranch {
  branch: string;
  changeId: string;
  artifact: "intent" | "spec" | "plan" | "incident";
  head: string;
}

/** Local `sdlc/<CHG>/<artifact>` branches with commits not yet reachable from `base`. */
export async function artifactBranches(dir: string, base = "HEAD"): Promise<ArtifactBranch[]> {
  const out: ArtifactBranch[] = [];
  for (const branch of await localBranches(dir)) {
    const m = ARTIFACT_BRANCH.exec(branch);
    if (!m?.[1] || !m[2]) continue;
    if (await isAncestor(dir, branch, base)) continue;
    const head = (await gitRaw(dir, ["rev-parse", branch])).stdout.trim();
    out.push({ branch, changeId: m[1], artifact: m[2] as ArtifactBranch["artifact"], head });
  }
  return out;
}

function parseLedger(text: string, path: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const r = parseJsonl(line, path);
    if (r.value) out.push(...r.value);
  }
  return out;
}

/**
 * The committed tree at `ref` with every unmerged artifact branch's change
 * directory laid over it and the ledgers unioned — what the console shows so a
 * draft in review is visible before its accept merges it. Files outside
 * `sdlc/changes/<CHG>/` come from `ref` only.
 */
export async function readTreeWithBranches(dir: string, ref = "HEAD", opts: ReadTreeOptions = {}): Promise<{ tree: Tree; branches: ArtifactBranch[] }> {
  const base = await readTree(dir, ref, opts);
  const branches = await artifactBranches(dir, ref);
  if (branches.length === 0) return { tree: base, branches };
  const files = new Map<string, TreeFile>(base.files);
  for (const b of branches) {
    const prefix = `sdlc/changes/${b.changeId}/`;
    const other = await readTree(dir, b.branch, { prefixes: [prefix.slice(0, -1)] });
    const ledger = logPath(b.changeId);
    for (const [path, file] of other.files) {
      if (!path.startsWith(prefix)) continue;
      if (path === ledger) {
        const merged = sortEvents(dedupeEvents([...parseLedger(files.get(path)?.content ?? "", path), ...parseLedger(file.content, path)]));
        const content = stringifyJsonl(merged);
        files.set(path, { content, sha: files.get(path)?.content === content ? (files.get(path)?.sha ?? file.sha) : file.sha });
        continue;
      }
      files.set(path, file);
    }
  }
  return { tree: { ref: base.ref, files }, branches };
}

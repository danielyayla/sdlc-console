import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PO, writeSeed } from "@sdlc/fixtures";
import { addWorktree, artifactBranches, git, initRepo, mergeBranch, readTree, readTreeWithBranches } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-branches-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

const EVENT = (seq: number) => `{"schema":1,"id":"01J8TESTBRANCHEVENT000000${seq}","ts":"2026-09-03T10:0${seq}:00Z","seq":${seq},"cycle":1,"actor":{"type":"agent","id":"claude-code","session":"s-1"},"event":"artifact.committed","data":{"artifact":1,"path":"sdlc/changes/CHG-0022/spec.md","sha":"${"b".repeat(40)}"}}\n`;

describe("unmerged artifact branches overlay the committed tree (drafts in review)", () => {
  it("lists sdlc/<CHG>/<artifact> branches ahead of the base and lays their change directory over HEAD with the ledger unioned", async () => {
    const dir = await seeded();
    expect(await artifactBranches(dir, "main")).toEqual([]);
    const wt = join(dir, ".sdlc-state", "worktrees", "spec");
    await addWorktree(dir, wt, "sdlc/CHG-0022/spec", "main");
    // a branch with no commits of its own is not a draft
    expect(await artifactBranches(dir, "main")).toEqual([]);
    writeFileSync(join(wt, "sdlc/changes/CHG-0022/spec.md"), "---\nid: CHG-0022\n---\n# draft\n", "utf8");
    const ledger = join(wt, "sdlc/changes/CHG-0022/log.jsonl");
    writeFileSync(ledger, `${(await git(dir, ["show", "main:sdlc/changes/CHG-0022/log.jsonl"])).trimEnd()}\n${EVENT(3)}`, "utf8");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0022): propose spec.md"]);
    const head = (await git(dir, ["rev-parse", "sdlc/CHG-0022/spec"])).trim();

    expect(await artifactBranches(dir, "main")).toEqual([{ branch: "sdlc/CHG-0022/spec", changeId: "CHG-0022", artifact: "spec", head }]);
    const base = await readTree(dir, "main");
    expect(base.files.has("sdlc/changes/CHG-0022/spec.md")).toBe(false);
    const { tree, branches } = await readTreeWithBranches(dir, "main");
    expect(branches.map((b) => b.branch)).toEqual(["sdlc/CHG-0022/spec"]);
    expect(tree.ref).toBe(base.ref);
    expect(tree.files.get("sdlc/changes/CHG-0022/spec.md")?.content).toContain("# draft");
    const events = (tree.files.get("sdlc/changes/CHG-0022/log.jsonl")?.content ?? "").trim().split("\n");
    expect(events).toHaveLength(3);
    expect(events[2]).toContain("01J8TESTBRANCHEVENT0000003");
    // other changes come from main only
    expect(tree.files.get("sdlc/changes/CHG-0021/spec.md")?.sha).toBe(base.files.get("sdlc/changes/CHG-0021/spec.md")?.sha);

    // once merged, the branch stops overlaying
    await mergeBranch(dir, "sdlc/CHG-0022/spec", "merge spec", { id: PO, name: "Priya Owens" });
    expect((await readTreeWithBranches(dir, "main")).branches).toEqual([]);
  });
});

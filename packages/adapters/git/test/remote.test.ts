import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fastForwardBranch, git } from "../src/index.js";
import { PO, tempRepo, write } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A clone with a bare origin, and a second clone that moves origin's main the way a merge on the host does. */
async function withOrigin() {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  const base = mkdtempSync(join(tmpdir(), "sdlc-remote-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const bare = join(base, "origin.git");
  await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "origin", "main"]);
  const other = join(base, "other");
  await git(base, ["clone", "-q", bare, other]);
  await git(other, ["config", "user.name", PO.name]);
  await git(other, ["config", "user.email", PO.id]);
  await git(other, ["config", "commit.gpgsign", "false"]);
  const rev = async (d: string, ref: string) => (await git(d, ["rev-parse", ref])).trim();
  const advanceOrigin = async (file: string) => {
    write(other, file, `${file}\n`);
    await git(other, ["add", file]);
    await git(other, ["commit", "-q", "-m", `feat: ${file}`]);
    await git(other, ["push", "-q", "origin", "main"]);
    return rev(other, "HEAD");
  };
  const commitLocal = async (file: string) => {
    write(dir, file, `${file}\n`);
    await git(dir, ["add", file]);
    await git(dir, ["commit", "-q", "-m", `local: ${file}`]);
    return rev(dir, "HEAD");
  };
  return { dir, base, rev, advanceOrigin, commitLocal };
}

describe("fastForwardBranch (CHG-0008): move a branch to origin's without a checkout, never by force", () => {
  it("moves the ref when origin is ahead and the branch is not checked out; the root's checkout and index are untouched", async () => {
    const { dir, rev, advanceOrigin } = await withOrigin();
    await git(dir, ["checkout", "-q", "-b", "CHG-0001/elsewhere"]);
    const remote = await advanceOrigin("a.txt");
    const r = await fastForwardBranch(dir, "main");
    expect(r).toEqual({ refused: false, head: remote, moved: true });
    expect(await rev(dir, "main")).toBe(remote);
    expect(await rev(dir, "origin/main")).toBe(remote);
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("CHG-0001/elsewhere");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("reports no move when local and origin are equal", async () => {
    const { dir, rev } = await withOrigin();
    await git(dir, ["checkout", "-q", "-b", "CHG-0001/elsewhere"]);
    const head = await rev(dir, "main");
    expect(await fastForwardBranch(dir, "main")).toEqual({ refused: false, head, moved: false });
  });

  it("refuses a non-fast-forward and leaves the ref alone: local commits are never discarded", async () => {
    const { dir, rev, advanceOrigin, commitLocal } = await withOrigin();
    const local = await commitLocal("local.txt");
    await git(dir, ["checkout", "-q", "-b", "CHG-0001/elsewhere"]);
    await advanceOrigin("b.txt");
    const r = await fastForwardBranch(dir, "main");
    expect(r.refused).toBe(true);
    expect(r.refused && r.reason).toContain("non-fast-forward");
    expect(await rev(dir, "main")).toBe(local);
  });

  it("refuses when the branch is checked out in this clone", async () => {
    const { dir, rev, advanceOrigin } = await withOrigin();
    const before = await rev(dir, "main");
    await advanceOrigin("c.txt");
    const r = await fastForwardBranch(dir, "main");
    expect(r.refused).toBe(true);
    expect(r.refused && r.reason).toContain("checked out");
    expect(await rev(dir, "main")).toBe(before);
  });

  it("refuses when the branch is checked out in a linked worktree, and does not move it under that worktree", async () => {
    const { dir, base, rev, advanceOrigin } = await withOrigin();
    await git(dir, ["checkout", "-q", "-b", "CHG-0001/elsewhere"]);
    const wt = join(base, "main-wt");
    await git(dir, ["worktree", "add", "-q", wt, "main"]);
    const before = await rev(dir, "main");
    await advanceOrigin("d.txt");
    const r = await fastForwardBranch(dir, "main");
    expect(r.refused).toBe(true);
    expect(r.refused && r.reason).toContain("checked out at");
    expect(await rev(dir, "main")).toBe(before);
    expect(await rev(wt, "HEAD")).toBe(before);
  });
});

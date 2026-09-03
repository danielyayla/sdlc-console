import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accept, createChange, deriveChange, loadRepo, validateTree, type TransitionContext } from "@sdlc/core";
import {
  addWorktree,
  blobSha,
  changeIdsByRef,
  commitTrailers,
  commitWritePlan,
  diffFiles,
  fileHistory,
  git,
  headSha,
  identity,
  installMergeUnion,
  listWorktrees,
  mergeBranch,
  newUlid,
  readLedgerUnion,
  readTree,
  readWorkingTree,
  removeWorktree,
} from "../src/index.js";
import { BASE_FILES, ENG, PO, tempRepo, write } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
async function repo(files?: Record<string, string>) {
  const r = await tempRepo(files);
  cleanups.push(r.cleanup);
  return r.dir;
}
const ctx = (who: { id: string }, extra: Partial<TransitionContext> = {}): TransitionContext => ({
  now: "2026-09-04T09:00:00Z",
  newId: newUlid,
  actor: who,
  blobSha,
  ...extra,
});

describe("blobSha and ids", () => {
  it("matches git hash-object", async () => {
    const dir = await repo();
    const content = "hello\n";
    const fromGit = (await git(dir, ["hash-object", "--stdin"], { input: content })).trim();
    expect(blobSha(content)).toBe(fromGit);
  });
  it("ULIDs are 26 Crockford chars, time-ordered", () => {
    const a = newUlid(1_000_000);
    const b = newUlid(2_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe("readTree / readWorkingTree", () => {
  it("reads only the console's prefixes with git blob shas; working tree agrees", async () => {
    const dir = await repo();
    const tree = await readTree(dir);
    expect([...tree.files.keys()].sort()).toEqual(["CLAUDE.md", "sdlc/config.yaml", "sdlc/templates/intent.md"]);
    expect(tree.files.get("CLAUDE.md")?.sha).toBe(blobSha(BASE_FILES["CLAUDE.md"] ?? ""));
    expect(tree.ref).toBe(await headSha(dir));
    const wt = readWorkingTree(dir);
    expect(wt.files.get("sdlc/config.yaml")?.sha).toBe(tree.files.get("sdlc/config.yaml")?.sha);
    write(dir, "sdlc/config.yaml", "schema: 1\ndefaultRole: eng\nidentities: [{ id: x, roles: [eng] }]\n");
    expect(readWorkingTree(dir).files.get("sdlc/config.yaml")?.sha).not.toBe(tree.files.get("sdlc/config.yaml")?.sha);
  });
  it("handles multi-line and unicode content byte-exactly", async () => {
    const content = "# Título\n\n日本語 ✓\n\n```\nline\n```\n";
    const dir = await repo({ ...BASE_FILES, "sdlc/notes.md": content });
    const tree = await readTree(dir);
    expect(tree.files.get("sdlc/notes.md")?.content).toBe(content);
    expect(tree.files.get("sdlc/notes.md")?.sha).toBe(blobSha(content));
  });
});

describe("commitWritePlan round-trips through core", () => {
  it("createChange → commit → readTree → derive gives stage 1 with the gate open, author + trailers on the commit", async () => {
    const dir = await repo();
    const before = await readTree(dir);
    const r = createChange(loadRepo(before), { title: "Invoice CSV export", kind: "feature", risk: "routine", origin: { type: "idea" } }, ctx(PO));
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    const sha = await commitWritePlan(dir, r.plan, { identity: PO, branch: "main" });
    expect(sha).toBe(await headSha(dir));
    const log = await git(dir, ["log", "-1", "--format=%an <%ae>%n%s"]);
    expect(log).toContain("Pat Owner <po@example.com>");
    expect(log).toContain("sdlc(CHG-0001): create change · intent.md");
    const trailers = await commitTrailers(dir, sha);
    expect(trailers["SDLC-Actor"]).toBe("human:po@example.com");
    expect(trailers["SDLC-Event"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const after = await readTree(dir);
    const core = loadRepo(after);
    const files = core.changes.get("CHG-0001");
    if (!files) throw new Error("no change");
    const view = deriveChange(core, files);
    expect(view.valid).toBe(true);
    expect(view.stage).toBe(1);
    expect(view.gate).toBeNull(); // template placeholders → intent incomplete → gate closed
    expect(view.docs[0].state).toBe("draft");
    expect(view.docs[0].sha).toBe(blobSha(after.files.get("sdlc/changes/CHG-0001/intent.md")?.content ?? ""));
    // artifact.committed carries the real blob sha
    expect(files.events[1]?.event).toBe("artifact.committed");
    expect(files.events[1]?.event === "artifact.committed" && files.events[1].data.sha).toBe(view.docs[0].sha);
    expect(validateTree(core).blocking).toBe(false);
  });

  it("accept commits only the plan's paths and leaves other dirty files alone; chain holds with real shas", async () => {
    const dir = await repo();
    const created = createChange(loadRepo(await readTree(dir)), { title: "T", kind: "feature", risk: "routine", origin: { type: "idea" }, intentBody: "# Intent: T\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Affected users and systems\na\n\n## Constraints\nc\n\n## Open questions\nq\n" }, ctx(PO));
    if (!created.ok) throw new Error("create");
    await commitWritePlan(dir, created.plan, { identity: PO });
    write(dir, "README.md", "dirty\n");
    const core = loadRepo(await readTree(dir));
    const files = core.changes.get("CHG-0001");
    if (!files) throw new Error("no change");
    const view = deriveChange(core, files);
    const acc = accept(core, view, 1, ctx(PO));
    if (!acc.ok) throw new Error(JSON.stringify(acc.diagnostics));
    const sha = await commitWritePlan(dir, acc.plan, { identity: PO });
    expect(await diffFiles(dir, `${sha}~1`, sha)).toEqual(["sdlc/changes/CHG-0001/log.jsonl"]);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("dirty\n");
    expect(await diffFiles(dir, "HEAD")).toEqual(["README.md"]);
    const next = loadRepo(await readTree(dir));
    const v2 = deriveChange(next, next.changes.get("CHG-0001") ?? files);
    expect(v2.stage).toBe(2);
    expect(v2.acceptedGates).toEqual([1]);
    const history = await fileHistory(dir, "sdlc/changes/CHG-0001/log.jsonl");
    expect(history.map((h) => h.subject)).toEqual(["sdlc(CHG-0001): accept intent.md (gate 1)", "sdlc(CHG-0001): create change · intent.md"]);
  });

  it("refuses to commit on the wrong branch and applies deletes", async () => {
    const dir = await repo();
    const plan = { changeId: "CHG-0001", files: [{ path: "README.md", content: null }, { path: "sdlc/x.txt", content: "x\n" }], events: [], commitMessage: "sdlc(repo): test", trailers: {}, actor: { type: "human" as const, id: "po@example.com" } };
    await expect(commitWritePlan(dir, plan, { identity: PO, branch: "other" })).rejects.toThrow(/expected other/);
    await commitWritePlan(dir, plan, { identity: PO });
    expect(existsSync(join(dir, "README.md"))).toBe(false);
    expect((await readTree(dir)).files.get("sdlc/x.txt")?.content).toBe("x\n");
  });
});

describe("merge=union across branches", () => {
  it("installMergeUnion is idempotent and two branches appending to log.jsonl merge without conflict; the union ledger sees both", async () => {
    const dir = await repo();
    expect(installMergeUnion(dir)).toBe(true);
    expect(installMergeUnion(dir)).toBe(false);
    await git(dir, ["add", ".gitattributes"]);
    await git(dir, ["commit", "-q", "-m", "attrs"]);
    const created = createChange(loadRepo(await readTree(dir)), { title: "T", kind: "feature", risk: "routine", origin: { type: "idea" } }, ctx(PO));
    if (!created.ok) throw new Error("create");
    await commitWritePlan(dir, created.plan, { identity: PO });

    const note = (text: string, seq: number) => ({
      changeId: "CHG-0001",
      event: { schema: 1 as const, id: newUlid(), ts: "2026-09-04T10:00:00Z", seq, cycle: 1, actor: { type: "agent" as const, id: "claude-code", session: `s${seq}` }, event: "note" as const, data: { text } },
    });
    await git(dir, ["checkout", "-q", "-b", "CHG-0001/a"]);
    await commitWritePlan(dir, { changeId: "CHG-0001", files: [], events: [note("from a", 3)], commitMessage: "sdlc(CHG-0001): note a", trailers: {}, actor: { type: "agent", id: "claude-code", session: "s3" } }, { identity: ENG });
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["checkout", "-q", "-b", "CHG-0001/b"]);
    await commitWritePlan(dir, { changeId: "CHG-0001", files: [], events: [note("from b", 4)], commitMessage: "sdlc(CHG-0001): note b", trailers: {}, actor: { type: "agent", id: "claude-code", session: "s4" } }, { identity: ENG });

    const union = await readLedgerUnion(dir, "CHG-0001");
    expect(union.events.map((e) => (e.event === "note" ? e.data.text : e.event))).toEqual(["change.created", "artifact.committed", "from a", "from b"]);
    expect(union.branches.sort()).toEqual(["CHG-0001/a", "CHG-0001/b", "main"]);
    expect(await changeIdsByRef(dir)).toEqual({ main: ["CHG-0001"], "CHG-0001/a": ["CHG-0001"], "CHG-0001/b": ["CHG-0001"] });

    await git(dir, ["checkout", "-q", "main"]);
    await mergeBranch(dir, "CHG-0001/a", "merge a", ENG);
    const mergeSha = await mergeBranch(dir, "CHG-0001/b", "merge b", ENG);
    expect(mergeSha).toBe(await headSha(dir));
    const ledger = readFileSync(join(dir, "sdlc/changes/CHG-0001/log.jsonl"), "utf8").trim().split("\n");
    expect(ledger).toHaveLength(4);
    expect(ledger.some((l) => l.includes("from a")) && ledger.some((l) => l.includes("from b"))).toBe(true);
  });
});

describe("worktrees", () => {
  it("adds a worktree on a new branch, lists it, removes it", async () => {
    const dir = await repo();
    const path = join(dir, "..", `${dir.split("/").pop() ?? "wt"}-CHG-0001-src`);
    await addWorktree(dir, path, "CHG-0001/src");
    const list = await listWorktrees(dir);
    expect(list.map((w) => w.branch)).toEqual(["main", "CHG-0001/src"]);
    expect(existsSync(join(path, "CLAUDE.md"))).toBe(true);
    await removeWorktree(dir, path);
    expect((await listWorktrees(dir)).map((w) => w.branch)).toEqual(["main"]);
    expect((await git(dir, ["branch", "--list", "CHG-0001/src"])).trim()).toContain("CHG-0001/src");
  });
});

describe("identity", () => {
  it("reads the acting human from git config", async () => {
    const dir = await repo();
    expect(await identity(dir)).toEqual({ id: "po@example.com", name: "Pat Owner" });
  });
});

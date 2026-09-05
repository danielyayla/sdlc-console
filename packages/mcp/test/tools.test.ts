import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { git, initRepo } from "@sdlc/adapter-git";
import { main, type Io } from "@sdlc/cli";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { readTree } from "@sdlc/adapter-git";
import { createSdlcServer } from "../src/index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-mcp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

async function client(dir: string, env: Record<string, string> = {}): Promise<Client> {
  const server = createSdlcServer({ cwd: dir, env: { ...env }, now: () => new Date("2026-09-03T12:00:00Z") });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  cleanups.push(async () => {
    await c.close();
    await server.close();
  });
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: Record<string, unknown> }> {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  const text = r.content[0]?.text ?? "{}";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { error: text };
  }
  return { isError: r.isError === true, value: r.structuredContent ?? parsed };
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return deriveChange(repo, files);
}

async function sdlc(dir: string, args: string[], identity = PO): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdin: () => Promise.resolve(""), env: { SDLC_IDENTITY: identity }, cwd: dir };
  return { code: await main(args, io), out: out.join(""), err: err.join("") };
}

const INTENT = "# Intent: Dunning reminders schedule\n\n## Problem\nOverdue invoices get no reminders.\n\n## Proposed outcome\nThree reminders at 7, 14 and 30 days.\n\n## Affected users and systems\nFinance; email service.\n\n## Constraints\nBrand voice; no reminders on disputed invoices.\n\n## Open questions\nEscalate after 30 days?\n";

describe("sdlc-mcp tools", () => {
  it("lists the twelve tools and no accept/merge/approve/freeze-lift/repro-confirm", async () => {
    const dir = await seeded();
    const c = await client(dir);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_change", "get_context", "list_work", "log_note", "propose_artifact", "propose_claude_md_line", "report_done", "report_finding", "report_repro", "report_round", "request_input", "submit_plan_revision"]);
    expect(names.some((n) => /accept|merge|approve|lift|confirm/.test(n))).toBe(false);
  });

  it("propose_claude_md_line (2.8): keeps a one-line draft beside the session; a reason already answered by a proposal is refused", async () => {
    const dir = await seeded();
    const c = await client(dir, { SDLC_SESSION: "sess-prop" });
    const answered = await call(c, "propose_claude_md_line", { changeId: "CHG-0018", text: "x", citations: ["CHG-0018"], reason: "Commit touches files outside plan.md's file list" });
    expect(answered.isError).toBe(true);
    expect(String(answered.value["error"])).toContain("PRP-0008 (open) already answers");
    const multi = await call(c, "propose_claude_md_line", { changeId: "CHG-0018", text: "two\nlines", citations: ["CHG-0018"], reason: "test freeze active" });
    expect(multi.isError).toBe(true);
    const r = await call(c, "propose_claude_md_line", { changeId: "CHG-0018", text: "  Under a repro freeze, propose test changes with request_input; never edit the test.  ", citations: ["CHG-0018", "CHG-0019"], reason: "Test Freeze Active" });
    expect(r.isError).toBe(false);
    expect(r.value).toMatchObject({ text: "Under a repro freeze, propose test changes with request_input; never edit the test.", reason: "test freeze active", citations: ["CHG-0018", "CHG-0019"] });
    const draft = JSON.parse(readFileSync(join(dir, ".sdlc-state/sessions/sess-prop/proposal.json"), "utf8")) as Record<string, unknown>;
    expect(draft).toMatchObject({ text: "Under a repro freeze, propose test changes with request_input; never edit the test.", reason: "test freeze active", ts: "2026-09-03T12:00:00Z" });
    // nothing committed, nothing under sdlc/proposals yet: the system files it when the session ends
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe("sdlc(repo): seed");
  });

  it("report_repro (2.7): commits the failing test alone on the task branch, records repro.failed and keeps the draft; refuses features, committed repros, paths outside the test globs and commits that carry more than the test", async () => {
    const dir = await seeded();
    // CHG-0018 is the seed's fix with its repro already committed → refused; reset it to the reporting state
    const changeYaml = join(dir, "sdlc/changes/CHG-0018/change.yaml");
    const original = readFileSync(changeYaml, "utf8");
    const { writeFileSync: write, mkdirSync: mkdir } = await import("node:fs");
    const wt = join(dir, "..", `${dir.split("/").pop() ?? "wt"}-repro`);
    cleanups.push(() => rmSync(wt, { recursive: true, force: true }));
    await git(dir, ["worktree", "add", "-q", "-b", "CHG-0018/export-fix", wt, "main"]);
    const c = await client(wt, { SDLC_SESSION: "sess-r1", SDLC_CHANGE: "CHG-0018" });
    mkdir(join(wt, "test/export"), { recursive: true });
    write(join(wt, "test/export/zero-total.test.ts"), "it('exports zero-total rows', () => { expect(rows).toHaveLength(4); });\n");
    const committedAlready = await call(c, "report_repro", { testPath: "test/export/zero-total.test.ts", failureReason: "expected 4 rows, received 3", output: "AssertionError: expected 4 rows, received 3" });
    expect(committedAlready.isError).toBe(true);
    expect(String(committedAlready.value["error"])).toContain("already has its repro test committed");
    write(join(wt, "sdlc/changes/CHG-0018/change.yaml"), original.replace(/repro:\n(?: {2}.*\n)+/, "repro: null\n"));
    await git(wt, ["rm", "-q", "--cached", "sdlc/changes/CHG-0018/evals/repro.json"]);
    rmSync(join(wt, "sdlc/changes/CHG-0018/evals/repro.json"));
    await git(wt, ["add", "sdlc/changes/CHG-0018/change.yaml"]);
    await git(wt, ["commit", "-q", "-m", "test: repro not yet reported"]);

    const outside = await call(c, "report_repro", { testPath: "src/export/csv.ts", failureReason: "x", output: "y" });
    expect(outside.isError).toBe(true);
    expect(String(outside.value["error"])).toContain("does not exist in this worktree");
    write(join(wt, "src-not-a-test.ts"), "x\n");
    const notTest = await call(c, "report_repro", { testPath: "src-not-a-test.ts", failureReason: "x", output: "y" });
    expect(String(notTest.value["error"])).toContain("is not under the test globs");

    // a stray edit in the worktree is not swept into the repro commit
    mkdir(join(wt, "src"), { recursive: true });
    write(join(wt, "src/stray.ts"), "export const stray = 1;\n");
    const r = await call(c, "report_repro", { testPath: "test/export/zero-total.test.ts", failureReason: "expected 4 rows, received 3", output: "AssertionError: expected 4 rows, received 3\n  at test/export/zero-total.test.ts:12:5" });
    expect(r.isError).toBe(false);
    const sha = String(r.value["sha"]);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(String(r.value["note"])).toContain("stop here");
    expect((await git(wt, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).trim()).toBe("test/export/zero-total.test.ts");
    expect((await git(wt, ["log", "-1", "--format=%s", sha])).trim()).toBe("sdlc(CHG-0018): repro test test/export/zero-total.test.ts");
    expect((await git(wt, ["status", "--porcelain", "--", "src/stray.ts"])).trim()).toContain("src/stray.ts");
    const draft = JSON.parse(readFileSync(join(wt, ".sdlc-state/sessions/sess-r1/repro.json"), "utf8")) as { testPath: string; sha: string; output: string };
    expect(draft).toMatchObject({ testPath: "test/export/zero-total.test.ts", sha, output: "AssertionError: expected 4 rows, received 3\n  at test/export/zero-total.test.ts:12:5" });
    const ledger = readFileSync(join(wt, "sdlc/changes/CHG-0018/log.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(ledger.at(-1) ?? "{}")).toMatchObject({ event: "repro.failed", actor: { type: "agent", session: "sess-r1" }, data: { testPath: "test/export/zero-total.test.ts", failureReason: "expected 4 rows, received 3" } });
    // a feature has no repro
    const feature = await call(c, "report_repro", { changeId: "CHG-0017", testPath: "test/export/zero-total.test.ts", failureReason: "x", output: "y" });
    expect(String(feature.value["error"])).toContain("repro-first applies to fixes");
  }, 30_000);

  it("list_work, get_change, get_context describe the awaited artifact and the bundle", async () => {
    const dir = await seeded();
    const c = await client(dir);
    const work = await call(c, "list_work", {});
    expect((work.value["work"] as { id: string; awaited: string }[]).map((w) => [w.id, w.awaited])).toEqual([["CHG-0023", "intent.md"], ["CHG-0018", "evals"]]);
    const change = await call(c, "get_change", { id: "CHG-0020" });
    expect(change.value["stage"]).toBe(3);
    const ctx = await call(c, "get_context", { changeId: "CHG-0020" });
    expect(ctx.value["job"]).toBe("plan-session");
    expect(String(ctx.value["manifest"])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((ctx.value["files"] as { path: string }[]).map((f) => f.path)).toEqual(expect.arrayContaining(["sdlc/changes/CHG-0020/intent.md", "sdlc/changes/CHG-0020/spec.md", "CLAUDE.md", ".claude/skills/brand/SKILL.md"]));
    expect((ctx.value["allowedTools"] as string[]).some((t) => /accept|merge/.test(t))).toBe(false);
  });

  it("propose_artifact refuses on main, validates, commits a complete intent on a change branch with manifest and agent author; accept on main merges it", async () => {
    const dir = await seeded();
    const c = await client(dir, { SDLC_SESSION: "sess-intent" });
    const onMain = await call(c, "propose_artifact", { changeId: "CHG-0023", index: 0, body: INTENT });
    expect(onMain.isError).toBe(true);
    expect(String(onMain.value["error"])).toContain("default branch");

    await git(dir, ["checkout", "-q", "-b", "sdlc/CHG-0023/intent"]);
    const incomplete = await call(c, "propose_artifact", { changeId: "CHG-0023", index: 0, body: "# Intent: x\n\n## Problem\np\n" });
    expect(incomplete.isError).toBe(true);
    expect(String(incomplete.value["error"])).toContain("missing");
    const wrongIndex = await call(c, "propose_artifact", { changeId: "CHG-0023", index: 1, body: INTENT });
    expect(wrongIndex.isError).toBe(true);

    const r = await call(c, "propose_artifact", { changeId: "CHG-0023", index: 0, body: INTENT });
    expect(r.isError).toBe(false);
    expect(r.value["path"]).toBe("sdlc/changes/CHG-0023/intent.md");
    const text = readFileSync(join(dir, "sdlc/changes/CHG-0023/intent.md"), "utf8");
    expect(text).toContain("author: claude-code@sdlc.local");
    expect(text).toContain("context_manifest: sha256:");
    const log = await git(dir, ["log", "-1", "--format=%an <%ae>%n%s"]);
    expect(log).toContain("claude-code <claude-code@sdlc.local>");
    expect(log).toContain("sdlc(CHG-0023): propose intent.md");
    const onBranch = await viewOf(dir, "CHG-0023");
    expect(onBranch.gate?.s).toBe(1);
    expect(onBranch.activity[0]?.actor).toBe("agent");

    await git(dir, ["checkout", "-q", "main"]);
    expect((await viewOf(dir, "CHG-0023")).gate).toBeNull();
    const accepted = await sdlc(dir, ["accept", "CHG-0023", "--gate", "1", "--json"]);
    expect(accepted.code, accepted.err + accepted.out).toBe(0);
    const after = await viewOf(dir, "CHG-0023");
    expect(after.stage).toBe(2);
    expect(after.docs[0].state).toBe("committed");
    const audit = await sdlc(dir, ["audit", "CHG-0023", "--json"]);
    expect(JSON.parse(audit.out).clean).toBe(true);
  });

  it("submit_plan_revision drafts then opens gate 3 when final", async () => {
    const dir = await seeded();
    await git(dir, ["checkout", "-q", "-b", "sdlc/CHG-0021/plan"]);
    const c = await client(dir);
    // CHG-0021 is at stage 2 → refused
    const early = await call(c, "submit_plan_revision", { changeId: "CHG-0021", body: "# Plan\n", final: false });
    expect(early.isError).toBe(true);
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["checkout", "-q", "-b", "sdlc/CHG-0019/plan"]);
    const body = "# Plan: Payment provider migration\n\n## Files that change\nsrc/payments/gateway.ts\nsrc/payments/providers/newco.ts (new)\n\n## Order of work\n1. adapter\n2. flag\n\n## Risks\nwebhooks\n\n## Proof\ntest/payments\n";
    const draft = await call(c, "submit_plan_revision", { changeId: "CHG-0019", body, final: false, acceptanceLine: "reconciliation 0 mismatches" });
    expect(draft.isError).toBe(false);
    expect(draft.value["rev"]).toBe(4);
    let v = await viewOf(dir, "CHG-0019");
    expect(v.planRev).toBe(4);
    expect(v.gate).toBeNull();
    expect(v.status).toBe("Agent drafting plan.md · rev 4");
    const final = await call(c, "submit_plan_revision", { changeId: "CHG-0019", body, final: true });
    expect(final.value["rev"]).toBe(5);
    v = await viewOf(dir, "CHG-0019");
    expect(v.gate).toMatchObject({ s: 3, ownerRole: "tech_lead" });
    expect(readFileSync(join(dir, "sdlc/changes/CHG-0019/plan.md"), "utf8")).toContain('acceptance_line: reconciliation 0 mismatches');
  });

  it("report_round / report_done enforce green-before-done and commit the final round as evidence; request_input and log_note write events", async () => {
    const dir = await seeded();
    await git(dir, ["checkout", "-q", "-b", "CHG-0018/export-fix"]);
    const c = await client(dir, { SDLC_SESSION: "sess-fix" });
    const blocked = await call(c, "report_done", {});
    expect(blocked.value).toMatchObject({ accepted: false, blocked: true });
    const red = await call(c, "report_round", { results: [{ name: "build", pass: true, outputExcerpt: "ok" }, { name: "test", pass: false, outputExcerpt: "1 failed" }] });
    expect(red.value).toMatchObject({ n: 1, loopState: "iterating" });
    expect((await call(c, "report_done", {})).value["accepted"]).toBe(false);
    const green = await call(c, "report_round", { results: [{ name: "build", pass: true, outputExcerpt: "ok" }, { name: "test", pass: true, outputExcerpt: "45 passed" }] });
    expect(green.value["loopState"]).toBe("flaky"); // no file changed between red and green
    const done = await call(c, "report_done", { evidenceRef: "rounds.jsonl" });
    expect(done.value).toMatchObject({ accepted: true, committed: true, finalRound: 2 });
    const tree = await git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "sdlc/changes/CHG-0018/evals"]);
    expect(tree).toContain("sdlc/changes/CHG-0018/evals/final-round.json");
    const v = await viewOf(dir, "CHG-0018");
    expect(v.activity.slice(0, 3).map((a) => a.event)).toEqual(["session.stopped", "round", "round"]);

    const q = await call(c, "request_input", { question: "Keep zero-total rows in totals?" });
    expect(q.value["ack"]).toBe(true);
    expect(readFileSync(join(dir, ".sdlc-state/sessions/sess-fix/waiting.json"), "utf8")).toContain("zero-total");
    const note = await call(c, "log_note", { changeId: "CHG-0018", text: "filter removed in csv.ts" });
    expect(note.isError).toBe(false);
    const v2 = await viewOf(dir, "CHG-0018");
    expect(v2.activity[0]?.text).toBe("filter removed in csv.ts");
    expect(v2.activity[1]?.text).toContain("Keep zero-total rows");
  }, 20_000);

  it("report_finding keeps findings with the session (no commit, PR head untouched) and refuses a change without a PR", async () => {
    const dir = await seeded();
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const c = await client(dir, { SDLC_SESSION: "sess-review01" });
    // CHG-0018 is at stage 4 without pr.yaml
    const refused = await call(c, "report_finding", { changeId: "CHG-0018", severity: "high", title: "unguarded null" });
    expect(refused.isError).toBe(true);
    expect(String(refused.value["error"])).toContain("no pull request");
    // CHG-0017 is in Deploy with an open PR
    const one = await call(c, "report_finding", { changeId: "CHG-0017", severity: "high", title: "CSV export ignores the header row", path: "src/export/csv.ts", detail: "line 12: rows.slice(1) drops the header before the truthiness filter" });
    expect(one.isError).toBe(false);
    expect(one.value).toMatchObject({ n: 1, changeId: "CHG-0017", tally: { high: 1, medium: 0, low: 0 } });
    const two = await call(c, "report_finding", { changeId: "CHG-0017", severity: "low", title: "naming: exportCsv vs export_csv" });
    expect(two.value).toMatchObject({ n: 2, tally: { high: 1, medium: 0, low: 1 } });
    const lines = readFileSync(join(dir, ".sdlc-state", "sessions", "sess-review01", "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { n: number; severity: string; title: string; path?: string });
    expect(lines.map((l) => [l.n, l.severity, l.path ?? null])).toEqual([[1, "high", "src/export/csv.ts"], [2, "low", null]]);
    // nothing was committed: the system mirrors findings when the session ends
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
    const merged = await call(c, "report_finding", { changeId: "CHG-0012", severity: "low", title: "late" });
    expect(merged.isError).toBe(true);
    expect(String(merged.value["error"])).toContain("already merged");
  });

  it("from a code-branch worktree the tools see the PR the run recorded on the default branch (pr.yaml lives there, not on the branch)", async () => {
    const dir = await seeded();
    const { appendFileSync: append } = await import("node:fs");
    const wt = join(dir, "..", `${dir.split("/").pop() ?? "wt"}-review`);
    cleanups.push(() => rmSync(wt, { recursive: true, force: true }));
    // CHG-0017's code branch as the build session left it: cut before the run recorded the PR on main, with its own note on top
    await git(dir, ["worktree", "add", "-q", "-b", "CHG-0017/export", wt, "main"]);
    await git(wt, ["rm", "-q", "sdlc/changes/CHG-0017/pr.yaml"]);
    append(join(wt, "sdlc/changes/CHG-0017/log.jsonl"), `${JSON.stringify({ schema: 1, id: "01J8Z6Q7Y2K3M4N5P6Q7R8S9T1", ts: "2026-09-04T09:00:00Z", seq: 99, cycle: 1, actor: { type: "agent", id: "claude-code", session: "sess-b1" }, event: "note", data: { text: "build session note" } })}\n`);
    await git(wt, ["commit", "-q", "-am", "sdlc(CHG-0017): note"]);
    const head = (await git(wt, ["rev-parse", "HEAD"])).trim();
    expect((await git(wt, ["ls-tree", "--name-only", "HEAD", "sdlc/changes/CHG-0017/"])).includes("pr.yaml")).toBe(false);
    // the review session runs in the branch worktree and still sees the PR
    const c = await client(wt, { SDLC_SESSION: "sess-review02", SDLC_CHANGE: "CHG-0017" });
    const ctx = await call(c, "get_change", { id: "CHG-0017" });
    expect(ctx.value["error"] ?? null).toBeNull();
    expect(ctx.isError).toBe(false);
    expect(ctx.value).toMatchObject({ stage: 5 });
    const one = await call(c, "report_finding", { changeId: "CHG-0017", severity: "medium", title: "header row dropped", path: "src/export/csv.ts" });
    expect(one.isError).toBe(false);
    expect(one.value).toMatchObject({ n: 1, changeId: "CHG-0017", tally: { high: 0, medium: 1, low: 0 } });
    // the read changed nothing on the branch
    expect((await git(wt, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect((await git(wt, ["ls-tree", "--name-only", "HEAD", "sdlc/changes/CHG-0017/"])).includes("pr.yaml")).toBe(false);
  });
});

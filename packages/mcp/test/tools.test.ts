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
  return { isError: r.isError === true, value: r.structuredContent ?? (JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>) };
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
  it("lists the nine tools and no accept/merge/approve", async () => {
    const dir = await seeded();
    const c = await client(dir);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_change", "get_context", "list_work", "log_note", "propose_artifact", "report_done", "report_round", "request_input", "submit_plan_revision"]);
  });

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
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { main, type Io } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Run {
  code: number;
  out: string;
  err: string;
  json: <T = unknown>() => T;
}

function makeIo(dir: string, env: Record<string, string> = {}, stdin = ""): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    stdin: () => Promise.resolve(stdin),
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    cwd: dir,
  };
  return { io, out, err };
}

async function sdlc(dir: string, args: string[], env: Record<string, string> = {}, stdin = ""): Promise<Run> {
  const { io, out, err } = makeIo(dir, env, stdin);
  const code = await main(args, io);
  const o = out.join("");
  return { code, out: o, err: err.join(""), json: <T,>() => JSON.parse(o) as T };
}

async function freshRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: "po@example.com", name: "Pat Owner" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  put(dir, "CLAUDE.md", "# P\n\n## Verifying your work\n- Build: `pnpm build`\n- Test: `pnpm test` (all green)\n- Lint: `pnpm lint`\n");
  put(dir, "README.md", "x\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "baseline"]);
  return dir;
}

function put(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
}

const FULL_INTENT = "# Intent: Export\n\n## Problem\nFinance cannot export.\n\n## Proposed outcome\nCSV per month.\n\n## Affected users and systems\nFinance; invoicing.\n\n## Constraints\nNo PII.\n\n## Open questions\nNone.\n";

async function initAndCommit(dir: string): Promise<void> {
  const r = await sdlc(dir, ["init", "--json"]);
  expect(r.code).toBe(0);
  // give the engineer role to a second identity so ownership is meaningful
  put(dir, "sdlc/config.yaml", "schema: 1\ndefaultRole: po\ncodeHost: local\nidentities:\n  - { id: po@example.com, name: Pat Owner, roles: [po] }\n  - { id: eng@example.com, name: Eng Ineer, roles: [eng, tech_lead] }\nthresholds: { autoFilesMax: 12 }\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): init"]);
}

describe("sdlc init", () => {
  it("creates the sdlc tree, templates, queues, .gitattributes and .gitignore entry, idempotently", async () => {
    const dir = await freshRepo();
    const first = await sdlc(dir, ["init", "--json"]);
    expect(first.code).toBe(0);
    const created = first.json<{ created: string[]; skipped: string[] }>();
    expect(created.created).toEqual(expect.arrayContaining(["sdlc/config.yaml", "sdlc/templates/intent.md", "sdlc/templates/plan.md", "sdlc/loop/triage/.gitkeep", "evals/cases/.gitkeep", ".gitattributes", ".gitignore (.sdlc-state/)"]));
    expect(created.skipped).toEqual([]);
    const second = await sdlc(dir, ["init", "--json"]);
    expect(second.json<{ created: string[] }>().created).toEqual([]);
    const attr = await git(dir, ["check-attr", "merge", "sdlc/changes/CHG-0001/log.jsonl"]);
    expect(attr).toContain("merge: union");
    const human = await sdlc(dir, ["init"]);
    expect(human.out).toContain("kept     sdlc/config.yaml");
  });
  it("refuses outside a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-nogit-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = await sdlc(dir, ["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a git repository");
  });
});

describe("change new / list / show / validate / accept / send-back / audit", () => {
  it("runs a change through gate 1 with a clean audit chain", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    put(dir, "intent-body.md", FULL_INTENT);
    const created = await sdlc(dir, ["change", "new", "--title", "Export", "--intent", "intent-body.md", "--json"]);
    expect(created.code).toBe(0);
    const c = created.json<{ id: string; view: { stage: number; gate: { s: number } | null } }>();
    expect(c.id).toBe("CHG-0001");
    expect(c.view.stage).toBe(1);
    expect(c.view.gate?.s).toBe(1);

    const list = await sdlc(dir, ["change", "list"]);
    expect(list.out).toContain("CHG-0001");
    expect(list.out).toContain("gate 1 → po");

    const validate = await sdlc(dir, ["validate", "--json"]);
    expect(validate.code).toBe(0);
    expect(validate.json<{ blocking: boolean }>().blocking).toBe(false);

    const wrongRole = await sdlc(dir, ["accept", "CHG-0001", "--gate", "1"], { SDLC_IDENTITY: "eng@example.com" });
    expect(wrongRole.code).toBe(2);
    expect(wrongRole.err).toContain("does not hold the product owner role");

    const asAgent = await sdlc(dir, ["accept", "CHG-0001", "--gate", "1"], { SDLC_ACTOR_TYPE: "agent" });
    expect(asAgent.code).toBe(2);
    expect(asAgent.err).toContain("human-only");

    const accepted = await sdlc(dir, ["accept", "CHG-0001", "--gate", "1", "--json"]);
    expect(accepted.code).toBe(0);
    expect(accepted.json<{ view: { stage: number } }>().view.stage).toBe(2);

    const show = await sdlc(dir, ["change", "show", "CHG-0001"]);
    expect(show.out).toContain("stage 2 · Design");
    expect(show.out).toContain("accepted intent.md (gate 1)");

    const audit = await sdlc(dir, ["audit", "CHG-0001", "--json"]);
    expect(audit.code).toBe(0);
    const a = audit.json<{ clean: boolean; steps: { kind: string; commit: string | null; ok: boolean }[]; breaks: string[] }>();
    expect(a.clean).toBe(true);
    expect(a.breaks).toEqual([]);
    expect(a.steps.map((s) => s.kind)).toEqual(["asked", "produced", "decided", "system"]);
    expect(a.steps[2]?.commit).toMatch(/^[0-9a-f]{40}$/);
    const rendered = await sdlc(dir, ["audit", "CHG-0001"]);
    expect(rendered.out).toContain("chain: clean");
    expect(rendered.out).toContain("po@example.com (po): accepted intent.md (gate 1)");

    const log = await git(dir, ["log", "--format=%an <%ae> %s", "-3"]);
    expect(log).toContain("Pat Owner <po@example.com> sdlc(CHG-0001): accept intent.md (gate 1)");
  });

  it("send-back keeps the stage; a template intent is not accepted until complete", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    const created = await sdlc(dir, ["change", "new", "--title", "Draft", "--json"]);
    expect(created.json<{ view: { gate: unknown; status: string } }>().view.gate).toBeNull();
    const refused = await sdlc(dir, ["accept", "CHG-0001", "--gate", "1"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("no open gate");

    put(dir, "sdlc/changes/CHG-0001/intent.md", `---\nid: CHG-0001\nartifact: intent\ncycle: 1\nauthor: po@example.com\ncreated: 2026-09-04T09:00:00Z\nschema: 1\n---\n${FULL_INTENT}`);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "fill intent"]);
    const sb = await sdlc(dir, ["send-back", "CHG-0001", "--gate", "1", "--feedback", "tighten the outcome", "--json"]);
    expect(sb.code).toBe(0);
    expect(sb.json<{ view: { stage: number; status: string } }>().view).toMatchObject({ stage: 1, status: "Agent revising intent.md per feedback" });
    const empty = await sdlc(dir, ["send-back", "CHG-0001", "--gate", "1", "--feedback", ""]);
    expect(empty.code).toBe(2);
  });

  it("audit reports a broken chain when the ledger is hand-edited with an agent acceptance", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    put(dir, "intent-body.md", FULL_INTENT);
    await sdlc(dir, ["change", "new", "--title", "Export", "--intent", "intent-body.md"]);
    const forged = JSON.stringify({ schema: 1, id: "01J8Z6Q7Y2K3M4N5P6Q7R8S9TA", ts: "2026-09-04T09:00:00Z", seq: 3, cycle: 1, actor: { type: "agent", id: "claude-code", session: "s1" }, event: "gate.accepted", data: { gate: 1, artifactSha: "0".repeat(40), source: "cli" } });
    const logPath = join(dir, "sdlc/changes/CHG-0001/log.jsonl");
    writeFileSync(logPath, `${(await git(dir, ["show", "HEAD:sdlc/changes/CHG-0001/log.jsonl"])).trimEnd()}\n${forged}\n`);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "tamper"]);
    const v = await sdlc(dir, ["validate", "--json"]);
    expect(v.code).toBe(1);
    expect(v.json<{ diagnostics: { pointer?: string }[] }>().diagnostics.some((d) => d.pointer === "/actor/type")).toBe(true);
    const audit = await sdlc(dir, ["audit", "CHG-0001"]);
    expect(audit.code).toBe(1);
    expect(audit.out).toContain("chain: BROKEN");
  });

  it("loop --incident commits the incident then re-enters cycle 2", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    // hand-build a change at stage 6 (merged) on main
    const chg = "sdlc/changes/CHG-0001";
    put(dir, `${chg}/change.yaml`, `schema: 1\nid: CHG-0001\ntitle: Export\nkind: feature\nrisk: routine\ncreated: { by: po@example.com, at: "2026-09-01T09:00:00Z" }\norigin: { type: idea }\nrecord: null\ncycle: 1\nrepro: null\nclosed: null\n`);
    put(dir, `${chg}/intent.md`, `---\nid: CHG-0001\nartifact: intent\ncycle: 1\nauthor: po@example.com\ncreated: 2026-09-01T09:00:00Z\nschema: 1\n---\n${FULL_INTENT}`);
    put(dir, `${chg}/spec.md`, `---\nid: CHG-0001\nartifact: spec\ncycle: 1\nintent_sha: ${sha}\nskills: []\nconcerns: []\ncreated: 2026-09-01T10:00:00Z\nschema: 1\n---\n# Spec: Export\n\n## Requirements\nr\n\n## Design\nd\n\n## Areas of concern\nnone\n\n## Open questions carried forward\nnone\n`);
    put(dir, `${chg}/plan.md`, `---\nid: CHG-0001\nartifact: plan\ncycle: 1\nspec_sha: ${sha}\nrev: 1\naccepted_by: eng@example.com\naccepted_at: 2026-09-01T11:00:00Z\nacceptance_line: "tests pass"\nschema: 1\n---\n# Plan: Export\n\n## Files that change\nsrc/export.ts (new)\n\n## Order of work\n1. do\n\n## Risks\nnone\n\n## Proof\ntests\n`);
    const fp = { claudeMdSha: (await git(dir, ["rev-parse", "HEAD:CLAUDE.md"])).trim(), skills: [], hooksSha: "0".repeat(40), model: "claude-opus-5" };
    put(dir, `${chg}/evals/run-1.json`, JSON.stringify({ schema: 1, n: 1, changeId: "CHG-0001", cycle: 1, worktree: "CHG-0001/src", headSha: sha, fileSet: ["src/export.ts"], configRef: fp, results: [], commandResults: [{ name: "test", cmd: "pnpm test", exitCode: 0, pass: true, output: "ok" }], verdict: "green", startedAt: "2026-09-01T12:00:00Z" }));
    put(dir, `${chg}/pr.yaml`, `schema: 1\nprovider: local\nbranch: CHG-0001/src\nbaseBranch: main\nheadSha: ${sha}\nopenedAt: 2026-09-01T12:30:00Z\nmergedAt: 2026-09-01T13:00:00Z\nmergeSha: ${sha}\nreviewers: []\nchecks: []\nplanMatches: true\n`);
    const ev = (seq: number, actor: object, event: string, data: object) => JSON.stringify({ schema: 1, id: `01J8Z6Q7Y2K3M4N5P6Q7R8S9${seq.toString(36).toUpperCase().padStart(2, "0")}`.replace(/[ILOU]/g, "X"), ts: `2026-09-01T09:${String(seq).padStart(2, "0")}:00Z`, seq, cycle: 1, actor, event, data });
    const po = { type: "human", id: "po@example.com", role: "po" };
    const eng = { type: "human", id: "eng@example.com", role: "eng" };
    put(dir, `${chg}/log.jsonl`, [
      ev(1, po, "gate.accepted", { gate: 1, artifactSha: sha, source: "cli" }),
      ev(2, po, "gate.accepted", { gate: 2, artifactSha: sha, source: "cli" }),
      ev(3, eng, "gate.accepted", { gate: 3, artifactSha: sha, source: "cli" }),
      ev(4, { type: "system", id: "sdlc-bot" }, "pr.merged", { mergeSha: sha }),
    ].join("\n") + "\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "fixture at stage 6"]);
    const before = await sdlc(dir, ["change", "show", "CHG-0001", "--json"]);
    expect(before.json<{ stage: number; status: string }>()).toMatchObject({ stage: 6, status: "Deployed · monitoring" });

    put(dir, "incident.md", "# Incident: Export timeouts\n\n## Anomaly and evidence\np95 12s\n\n## Proposed outcome\nunder 1s\n\n## Affected systems\nexport api\n\n## Open questions\nwhy\n");
    const looped = await sdlc(dir, ["loop", "CHG-0001", "--incident", "incident.md", "--json"]);
    expect(looped.code).toBe(0);
    const l = looped.json<{ cycle: number; commits: string[]; view: { stage: number; status: string; kind: string } }>();
    expect(l.cycle).toBe(2);
    expect(l.commits).toHaveLength(2);
    expect(l.view).toMatchObject({ stage: 1, kind: "fix", status: "Loop closed — re-entered Plan from incident" });
    const tree = await git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "sdlc/changes/CHG-0001", "evals/cases"]);
    expect(tree).toContain("sdlc/changes/CHG-0001/cycles/1/plan.md");
    expect(tree).toContain("evals/cases/INC-CHG-0001-1.json");
    expect(tree).not.toContain("sdlc/changes/CHG-0001/pr.yaml");
    const validate = await sdlc(dir, ["validate", "--json"]);
    expect(validate.json<{ blocking: boolean }>().blocking).toBe(false);
    const audit = await sdlc(dir, ["audit", "CHG-0001"]);
    expect(audit.out).toContain("— cycle 2 —");
  });
});

describe("usage", () => {
  it("prints usage with no command and exits 1; --help exits 0", async () => {
    const dir = await freshRepo();
    expect((await sdlc(dir, [])).code).toBe(1);
    const h = await sdlc(dir, ["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("sdlc audit <CHG>");
  });
});

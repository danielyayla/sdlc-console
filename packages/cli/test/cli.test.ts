import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(created.created).toEqual(expect.arrayContaining(["sdlc/config.yaml", "sdlc/templates/intent.md", "sdlc/templates/plan.md", "sdlc/loop/triage/.gitkeep", "evals/cases/.gitkeep", ".gitattributes", ".gitignore (.sdlc-state/)", ".claude/hooks/plan-sync.sh", ".claude/settings.json"]));
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
    const fp = { claudeMdSha: (await git(dir, ["rev-parse", "HEAD:CLAUDE.md"])).trim(), skills: [], hooksSha: (await git(dir, ["rev-parse", "HEAD:.claude/settings.json"])).trim(), model: "claude-opus-5" };
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

describe("triage and security", () => {
  it("imports findings, routes them, and accepts/dismisses triage items", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    put(dir, "scan.csv", "scannerId,sev,conf,repo,title,desc\ncs:1,high,0.9,invoicing,SQL injection,unescaped\ncs:2,low,0.4,invoicing,Verbose errors,traces\n");
    const imported = await sdlc(dir, ["security", "import", "scan.csv", "--json"], { SDLC_IDENTITY: "eng@example.com" });
    expect(imported.code).toBe(0);
    expect(imported.json<{ imported: number }>().imported).toBe(2);
    expect((await sdlc(dir, ["security", "patch", "SEC-0002"], { SDLC_IDENTITY: "eng@example.com" })).code).toBe(0);
    expect((await sdlc(dir, ["security", "dismiss", "SEC-0002"], { SDLC_IDENTITY: "eng@example.com" })).code).toBe(2);
    const esc = await sdlc(dir, ["security", "escalate", "SEC-0001", "--json"], { SDLC_IDENTITY: "eng@example.com" });
    expect(esc.code).toBe(0);
    expect(esc.json<{ changeId: string }>().changeId).toBe("CHG-0001");
    expect((await sdlc(dir, ["security", "escalate", "SEC-0001"], { SDLC_IDENTITY: "po@example.com" })).code).toBe(2);

    put(dir, "sdlc/loop/triage/TRI-0001.md", "---\nschema: 1\nid: TRI-0001\ntier: 3σ\nsrc: metric:p95\ntitle: Slow export\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: open\n---\n" + FULL_INTENT);
    put(dir, "sdlc/loop/triage/TRI-0002.md", "---\nschema: 1\nid: TRI-0002\ntier: incident\nsrc: s\ntitle: Dup numbers\nevidence: e\ncreatedAt: 2026-09-03T10:00:00Z\nstatus: open\n---\nbody\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "triage items"]);
    const acc = await sdlc(dir, ["triage", "accept", "TRI-0001", "--json"]);
    expect(acc.code).toBe(0);
    expect(acc.json<{ changeId: string }>().changeId).toBe("CHG-0002");
    expect((await sdlc(dir, ["triage", "dismiss", "TRI-0002"])).code).toBe(2);
    expect((await sdlc(dir, ["triage", "dismiss", "TRI-0002", "--reason", "duplicate", "--tune", "n/a"])).code).toBe(0);
    const list = await sdlc(dir, ["change", "list", "--json"]);
    expect(list.json<{ id: string; origin: { ref?: string } }[]>().map((c) => c.origin.ref)).toEqual(["TRI-0001", "SEC-0001"]);
    expect((await sdlc(dir, ["validate"])).code).toBe(0);
  });
});

describe("sdlc hook", () => {
  it("reads harness JSON from stdin and exits 2 on a block, 0 otherwise", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    const stopJson = JSON.stringify({ session_id: "s", cwd: dir, hook_event_name: "Stop" });
    // main branch → no change context → allow
    expect((await sdlc(dir, ["hook", "verify-before-done"], {}, stopJson)).code).toBe(0);
    expect((await sdlc(dir, ["hook", "nope"], {}, "{}")).code).toBe(1);
    expect((await sdlc(dir, ["hook", "test-freeze"], {}, "not json")).code).toBe(0);
  });
});

describe("eval suite in CI (2.5)", () => {
  it("init writes the evals and validate workflows once", async () => {
    const dir = await freshRepo();
    const first = await sdlc(dir, ["init", "--json"]);
    const created = first.json<{ created: string[] }>().created;
    expect(created).toContain(".github/workflows/sdlc-evals.yml");
    expect(created).toContain(".github/workflows/sdlc-validate.yml");
    const evals = readFileSync(join(dir, ".github/workflows/sdlc-evals.yml"), "utf8");
    expect(evals).toContain("evals run --trigger");
    expect(evals).toContain("evals gate");
    expect(evals).toContain("- CLAUDE.md");
    expect(evals).toContain('- ".claude/**"');
    expect(evals).toContain("sdlc/evals-runs");
    expect(readFileSync(join(dir, ".github/workflows/sdlc-validate.yml"), "utf8")).toContain("validate");
    const second = await sdlc(dir, ["init", "--json"]);
    expect(second.json<{ skipped: string[] }>().skipped).toContain(".github/workflows/sdlc-evals.yml");
  });

  it("config-change gate (acceptance m): a CLAUDE.md change whose run regresses a case is blocked with before/after output; scheduled mode is not gated; harvest refuses an unmerged change", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    put(dir, "check.sh", "echo ok\n");
    put(dir, "evals/cases/CASE-0001.json", JSON.stringify({ schema: 1, id: "CASE-0001", prompt: "Export a month as CSV.", checks: [{ name: "check", cmd: "sh ./check.sh", healthyOutput: "ok" }], source: { type: "manual" }, owner: "po@example.com", added: "2026-09-01T00:00:00Z", status: "active", paths: ["src/export.ts"] }, null, 2));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "evals: CASE-0001"]);
    const run1 = await sdlc(dir, ["evals", "run", "--trigger", "config-pr", "--json"]);
    expect(run1.code).toBe(0);
    expect(run1.json<{ run: { id: string; verdict: string; passRate: number } }>().run).toMatchObject({ id: "RUN-0001", verdict: "pass", passRate: 1 });
    expect((await git(dir, ["log", "-1", "--format=%s %an"])).trim()).toBe("sdlc(evals): suite run RUN-0001 pass (1/1 of 1) sdlc-bot");
    const gate1 = await sdlc(dir, ["evals", "gate"]);
    expect(gate1.code).toBe(0);
    expect(gate1.out).toContain("ok: RUN-0001 pass · 100% vs threshold 90%");
    // the config changes and the check breaks
    put(dir, "CLAUDE.md", "# P\n\n- Never guess.\n\n## Verifying your work\n- Build: `pnpm build`\n- Test: `pnpm test` (all green)\n- Lint: `pnpm lint`\n");
    put(dir, "check.sh", "echo broken; exit 1\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "CLAUDE.md: never guess"]);
    const gateStale = await sdlc(dir, ["evals", "gate"]);
    expect(gateStale.code).toBe(1);
    expect(gateStale.out).toContain("no suite run for the current config");
    const run2 = await sdlc(dir, ["evals", "run", "--trigger", "config-pr"]);
    expect(run2.code).toBe(0);
    expect(run2.out).toContain("RUN-0002 fail · 0% (0/1)");
    expect(run2.out).toContain("✗ CASE-0001");
    expect(run2.out).toContain("broken");
    const gate2 = await sdlc(dir, ["evals", "gate"]);
    expect(gate2.code).toBe(1);
    expect(gate2.out).toContain("blocked: RUN-0002 fail · 0% vs threshold 90% · 1 regressed");
    expect(gate2.out).toContain("baseline RUN-0001");
    expect(gate2.out).toContain("regressed CASE-0001");
    expect(gate2.out).toMatch(/before:\n\s+--- check: sh \.\/check\.sh \(exit 0\)\n\s+ok/);
    expect(gate2.out).toMatch(/after:\n\s+--- check: sh \.\/check\.sh \(exit 1\)\n\s+broken/);
    const gateJson = await sdlc(dir, ["evals", "gate", "--json"]);
    expect(gateJson.json<{ ok: boolean; regressed: { caseId: string }[] }>()).toMatchObject({ ok: false, regressed: [{ caseId: "CASE-0001" }] });
    // scheduled mode: config PRs are not gated and the config-pr trigger runs nothing
    put(dir, "sdlc/config.yaml", `${readFileSync(join(dir, "sdlc/config.yaml"), "utf8")}evals: { mode: scheduled, schedule: "0 3 * * *" }\n`);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "config: scheduled evals"]);
    const gate3 = await sdlc(dir, ["evals", "gate"]);
    expect(gate3.code).toBe(0);
    expect(gate3.out).toContain("not gated");
    const skipped = await sdlc(dir, ["evals", "run", "--trigger", "config-pr", "--json"]);
    expect(skipped.json<{ skipped: string }>().skipped).toContain("scheduled");
    // agents cannot run or harvest
    expect((await sdlc(dir, ["evals", "run"], { SDLC_ACTOR_TYPE: "agent" })).code).toBe(2);
    // harvest needs a merged change
    const created = await sdlc(dir, ["change", "new", "--title", "Export", "--intent", "-", "--json"], {}, FULL_INTENT);
    expect(created.code).toBe(0);
    const harvest = await sdlc(dir, ["evals", "harvest", "CHG-0001"]);
    expect(harvest.code).toBe(2);
    expect(harvest.err).toContain("not merged (stage 1)");
  }, 30_000);
});

describe("session downgrade (2.6)", () => {
  it("is wired: usage without an id, not-found for an unknown session, and the usage line names it", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    const usage = await sdlc(dir, ["session", "downgrade"]);
    expect(usage.code).toBe(1);
    expect(usage.err).toContain("usage: sdlc session downgrade <id> [--reason <text>]");
    const missing = await sdlc(dir, ["session", "downgrade", "sess-nope", "--reason", "x"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("sess-nope not found");
    const agent = await sdlc(dir, ["session", "downgrade", "sess-nope"], { SDLC_ACTOR_TYPE: "agent" });
    expect(agent.code).toBe(2);
    const help = await sdlc(dir, ["nope"]);
    expect(help.err).toContain("downgrade <id> [--reason r]   (downgrade: AUTO → SUPERVISED, never upward)");
  });
});

describe("repro and freeze commands (2.7)", () => {
  it("are wired: usage lines, human-only, and a change without a reported repro test is refused with the hand-written form", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    expect((await sdlc(dir, ["repro"])).err).toContain("usage: sdlc repro confirm <CHG>");
    expect((await sdlc(dir, ["freeze", "lift", "CHG-0001"])).err).toContain("usage: sdlc freeze lift <CHG> --file <path> --reason <text>");
    put(dir, "intent-body.md", FULL_INTENT);
    const created = await sdlc(dir, ["change", "new", "--title", "Zero rows", "--kind", "fix", "--intent", "intent-body.md", "--json"]);
    expect(created.code).toBe(0);
    const agent = await sdlc(dir, ["repro", "reject", "CHG-0001", "--reason", "x"], { SDLC_ACTOR_TYPE: "agent" });
    expect(agent.code).toBe(2);
    const none = await sdlc(dir, ["repro", "confirm", "CHG-0001"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("has no reported repro test; pass --file, --reason and --sha");
    const help = await sdlc(dir, ["nope"]);
    expect(help.err).toContain("sdlc repro confirm <CHG>");
    expect(help.err).toContain("sdlc freeze lift <CHG> --file p --reason r");
  });
});

describe("proposal and trigger-test commands (2.8)", () => {
  const FAKE = fileURLToPath(new URL("../../server/test/fixtures/fake-claude.sh", import.meta.url));

  it("proposal accept|dismiss are wired, human-only, need eng or platform, and dismiss needs a reason", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    expect((await sdlc(dir, ["proposal"])).err).toContain("usage: sdlc proposal accept <PRP>");
    put(dir, "sdlc/proposals/PRP-0001.yaml", "schema: 1\nid: PRP-0001\ntype: claude-md-line\ntext: Run the tests before reporting done.\ncitations: [CHG-0001]\nreason: tests not run\nstatus: open\ncreatedAt: 2026-09-02T09:40:00Z\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "proposal"]);
    expect((await sdlc(dir, ["proposal", "accept", "PRP-0001"], { SDLC_ACTOR_TYPE: "agent" })).code).toBe(2);
    const po = await sdlc(dir, ["proposal", "accept", "PRP-0001"]);
    expect(po.code).toBe(1);
    expect(po.err).toContain("holds neither eng nor platform");
    const noReason = await sdlc(dir, ["proposal", "dismiss", "PRP-0001"], { SDLC_IDENTITY: "eng@example.com" });
    expect(noReason.code).toBe(2);
    expect(noReason.err).toContain("--reason is required");
    // local mode: accept cuts the branch with the line and marks the proposal; main's CLAUDE.md is untouched
    const accepted = await sdlc(dir, ["proposal", "accept", "PRP-0001", "--json"], { SDLC_IDENTITY: "eng@example.com" });
    expect(accepted.code).toBe(0);
    expect(accepted.json<{ toast: string }>().toast).toBe("PRP-0001 accepted — branch sdlc/proposals/PRP-0001 carries the line — open a PR from it for the code owners");
    expect(await git(dir, ["show", "sdlc/proposals/PRP-0001:CLAUDE.md"])).toContain("- Run the tests before reporting done.");
    expect(await git(dir, ["show", "main:CLAUDE.md"])).not.toContain("Run the tests before reporting done.");
    expect(await git(dir, ["show", "main:sdlc/proposals/PRP-0001.yaml"])).toContain("status: accepted");
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>", "sdlc/proposals/PRP-0001"])).trim()).toBe("Pat Owner <eng@example.com>"); // SDLC_IDENTITY overrides the email; the name comes from git
    expect((await sdlc(dir, ["proposal", "accept", "PRP-0001"], { SDLC_IDENTITY: "eng@example.com" })).code).toBe(1);
    const help = await sdlc(dir, ["nope"]);
    expect(help.err).toContain("sdlc proposal accept <PRP>");
    expect(help.err).toContain("sdlc evals trigger <skill> --prompt <text>");
  });

  it("evals trigger runs the harness headless and exits 0 only when the Skill tool loaded the skill", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    expect((await sdlc(dir, ["evals", "trigger"])).err).toContain("usage: sdlc evals trigger <skill> --prompt <text>");
    const loaded = await sdlc(dir, ["evals", "trigger", "brand", "--prompt", "Write the reminder copy.", "--json"], { SDLC_CLAUDE_BIN: FAKE, FAKE_CLAUDE_SKILL: "brand" });
    expect(loaded.code).toBe(0);
    expect(loaded.json<{ loaded: boolean; evidence: string }>()).toMatchObject({ loaded: true, skill: "brand", prompt: "Write the reminder copy." });
    expect(loaded.json<{ evidence: string }>().evidence).toContain('"name":"Skill"');
    const other = await sdlc(dir, ["evals", "trigger", "brand", "--prompt", "Write the reminder copy."], { SDLC_CLAUDE_BIN: FAKE, FAKE_CLAUDE_SKILL: "compliance" });
    expect(other.code).toBe(1);
    expect(other.out).toContain("not loaded: skill brand");
    const none = await sdlc(dir, ["evals", "trigger", "brand", "--prompt", "Write the reminder copy."], { SDLC_CLAUDE_BIN: FAKE });
    expect(none.code).toBe(1);
    expect(none.out).toContain("not loaded: skill brand");
    expect(none.out).toContain("working"); // the transcript tail is the evidence, verbatim
  });
});

describe("record commands (2.9, FR-16)", () => {
  it("record link writes change.yaml.record and the ledger (human, once), status shows modes and sync, retry says when nothing is owed", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    put(dir, "intent-body.md", FULL_INTENT);
    expect((await sdlc(dir, ["change", "new", "--title", "Export", "--intent", "intent-body.md", "--json"])).code).toBe(0);
    expect((await sdlc(dir, ["record"])).err).toContain("usage: sdlc record link <CHG>");
    expect((await sdlc(dir, ["record", "link", "CHG-0001", "--system", "jira"])).code).toBe(2);
    expect((await sdlc(dir, ["record", "link", "CHG-0001", "--system", "jira", "--id", "EXP-1"], { SDLC_ACTOR_TYPE: "agent" })).code).toBe(2);
    const linked = await sdlc(dir, ["record", "link", "CHG-0001", "--system", "jira", "--id", "EXP-1", "--url", "https://jira.example/browse/EXP-1"]);
    expect(linked.code).toBe(0);
    expect(linked.out).toContain("CHG-0001 linked to jira EXP-1");
    expect(readFileSync(join(dir, "sdlc/changes/CHG-0001/change.yaml"), "utf8")).toContain("id: EXP-1");
    expect(readFileSync(join(dir, "sdlc/changes/CHG-0001/log.jsonl"), "utf8")).toContain('"event":"record.linked"');
    const again = await sdlc(dir, ["record", "link", "CHG-0001", "--system", "jira", "--id", "EXP-2"]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already linked to jira EXP-1");
    const status = await sdlc(dir, ["record", "status", "CHG-0001"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("record: jira EXP-1 (https://jira.example/browse/EXP-1)  connector: none");
    expect(status.out).toContain("intent.md    repo      synced never");
    const json = await sdlc(dir, ["record", "status", "CHG-0001", "--json"]);
    expect(json.json<{ record: { id: string }; rows: { artifact: string; mode: string }[] }>().rows.map((r) => r.mode)).toEqual(["repo", "repo", "repo", "repo", "repo", "repo"]);
    const retry = await sdlc(dir, ["record", "retry", "CHG-0001", "intent"]);
    expect(retry.code).not.toBe(0);
    expect(retry.err).toContain("nothing to write back");
    expect((await sdlc(dir, ["record", "retry", "CHG-0001", "bogus"])).err).toContain("unknown artifact bogus");
    const show = await sdlc(dir, ["change", "show", "CHG-0001"]);
    expect(show.out).toContain("linked to jira EXP-1");
  });
});

describe("metrics (FR-70)", () => {
  it("prints the per-stage table with sources, says what a feed needs, and refuses bad windows and a refresh without GitHub", async () => {
    const dir = await freshRepo();
    await initAndCommit(dir);
    const table = await sdlc(dir, ["metrics"]);
    expect(table.code).toBe(0);
    expect(table.out).toContain("window 30d · PR metadata: none · CI: none · incident records: none");
    expect(table.out).toContain("01 Plan");
    expect(table.out).toContain("n/a · needs PR metadata");
    expect(table.out).toContain("[ledger]");
    const json = await sdlc(dir, ["metrics", "--stage", "4", "--window", "7d", "--json"]);
    expect(json.code).toBe(0);
    const r = json.json<{ window: string; metrics: { stage: number }[]; sources: { ci: { via: string } } }>();
    expect(r.window).toBe("7d");
    expect(r.metrics.map((s) => s.stage)).toEqual([4]);
    expect(r.sources.ci.via).toBe("none");
    expect((await sdlc(dir, ["metrics", "--window", "fortnight"])).code).toBe(2);
    expect((await sdlc(dir, ["metrics", "--stage", "9"])).code).toBe(2);
    const refresh = await sdlc(dir, ["metrics", "--refresh"]);
    expect(refresh.code).toBe(2);
    expect(refresh.err).toContain("config.codeHost github and GITHUB_TOKEN");
  });
});

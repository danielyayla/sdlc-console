import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { loadRepo, type BandStatus } from "@sdlc/core";
import { readSnapshots } from "@sdlc/detect";
import { PO, writeSeed } from "@sdlc/fixtures";
import type { MetricSnapshot } from "@sdlc/schemas";
import { appendRunbookRun, writeDiagnosisDraft } from "@sdlc/mcp";
import { Engine, JobStore, SessionRegistry, StateStore, bandTools, launchBandSession, startServer, worktreePathFor, type Exec } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The seed's bands with sources: p95 at 3σ (pr + rollback routes), error rate at 2σ (diagnose only), queue depth without a source. */
const BANDS = `baselineWindow: 30d
detectEvery: 30s
metrics:
  - metric: p95_latency_ms
    baseline: 310
    unit: ms
    sigma: 40
    source: "scripts/p95.sh"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep, "Bash(gh run view *)"] }
      3sigma: { action: propose, routes: [pr, "runbook:rollback"] }
  - metric: error_rate_pct
    baseline: 0.4
    unit: "%"
    sigma: 0.1
    source: "scripts/errors.sh"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep] }
      3sigma: { action: propose, routes: [pr] }
  - metric: queue_depth
    baseline: 12
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read] }
      3sigma: { action: propose, routes: [] }
runbooks:
  - id: rollback
    command: "echo rollback: previous release redeployed"
`;

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-maintain-"));
  cleanups.push(() => rmRetry(dir));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  writeFileSync(join(dir, "bands.yaml"), BANDS);
  // the seed's TRI-0042 already cites metric:p95_latency_ms; dismiss it so the breach below is new
  const tri = join(dir, "sdlc/loop/triage/TRI-0042.md");
  writeFileSync(tri, readFileSync(tri, "utf8").replace("status: open", "status: dismissed\ndismissal:\n  by: po@veri.example\n  reason: seed"));
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

/** Sources: p95 at 842 (3σ), error rate at 0.62 (2σ) unless overridden. */
function sources(values: Record<string, string> = {}): Exec {
  return (cmd) => {
    if (cmd.includes("p95")) return Promise.resolve({ exitCode: 0, output: values["p95"] ?? "export p95 (ms)\n842\n" });
    if (cmd.includes("errors")) return Promise.resolve({ exitCode: 0, output: values["errors"] ?? "0.62" });
    return Promise.resolve({ exitCode: 0, output: `${cmd}: ok` });
  };
}

function harness(dir: string, exec: Exec, autoLaunch = true, env: Record<string, string> = {}) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list(), snapshots: () => readSnapshots(dir) });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec, autoLaunch, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env } });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

async function repoAt(dir: string) {
  return loadRepo(await readTree(dir, "HEAD"));
}

describe("Maintain automation (3.4): a bands.yaml breach raises a triage item and a diagnose job without a human starting it", () => {
  it("detect(): snapshots written, 3σ → TRI + propose job, 2σ → TRI + diagnose job, sdlc-bot commits with the job key; a second pass double-launches nothing", async () => {
    const dir = await seeded();
    const argsFile = join(dir, "args.txt");
    const h = harness(dir, sources(), true, { FAKE_CLAUDE_ARGS: argsFile });
    await h.store.refresh();
    const before = await repoAt(dir);
    expect(before.triage.filter((t) => t.data.status === "open").map((t) => t.data.id)).toEqual(["TRI-0043"]);

    const r = await h.engine.detect();
    expect(r.skipped).toBeNull();
    const ts = r.pass?.ts ?? "";
    expect(r.pass?.results.map((x) => [x.band.metric, x.snapshot.current, x.snapshot.tier])).toEqual([
      ["p95_latency_ms", 842, 3],
      ["error_rate_pct", 0.62, 2],
    ]);
    expect(r.pass?.skipped).toEqual(["queue_depth"]);
    // the cache the table reads
    expect(Object.keys(readSnapshots(dir)).sort()).toEqual(["error_rate_pct", "p95_latency_ms"]);
    expect(h.store.current?.bandStatus.map((b) => [b.metric, b.tier, b.breached, b.triage])).toEqual([
      ["p95_latency_ms", 3, true, ["TRI-0044"]],
      ["error_rate_pct", 2, true, ["TRI-0045"]],
      ["queue_depth", null, false, []],
    ]);
    // the triage items, committed by sdlc-bot on main with the job keys as trailers
    expect(r.raised).toEqual([
      { id: "TRI-0044", metric: "p95_latency_ms", job: "band:p95_latency_ms:3σ:" + ts },
      { id: "TRI-0045", metric: "error_rate_pct", job: "band:error_rate_pct:2σ:" + ts },
    ]);
    const after = await repoAt(dir);
    const p95 = after.triage.find((t) => t.data.id === "TRI-0044");
    expect(p95?.data).toMatchObject({ tier: "3σ", src: "metric:p95_latency_ms", status: "open", job: `band:p95_latency_ms:3σ:${ts}` });
    expect(p95?.data.evidence).toContain("--- scripts/p95.sh (exit 0)\nexport p95 (ms)\n842");
    expect(after.triage.find((t) => t.data.id === "TRI-0045")?.data).toMatchObject({ tier: "2σ", src: "metric:error_rate_pct", status: "open" });
    const log = await git(dir, ["log", "-1", "--format=%an <%ae>%n%B"]);
    expect(log).toContain("sdlc-bot <sdlc-bot@sdlc.local>");
    expect(log).toContain("sdlc(bands): TRI-0044 p95_latency_ms, TRI-0045 error_rate_pct breached");
    expect(log).toContain(`SDLC-Job: band:p95_latency_ms:3σ:${ts} band:error_rate_pct:2σ:${ts}`);
    expect(log).toContain(`SDLC-Snapshot: p95_latency_ms@${ts} error_rate_pct@${ts}`);
    // the jobs, through the engine's queue, each with its headless session (the fake harness may already have exited)
    expect(r.jobs.map((j) => [j.kind, j.changeId, j.stage, j.sessionId !== null])).toEqual([
      ["propose", "", 6, true],
      ["diagnose", "", 6, true],
    ]);
    expect(r.jobs.every((j) => j.state === "running" || j.state === "done")).toBe(true);
    const sessions = h.registry.list();
    expect(sessions.map((s) => [s.kind, s.mode, s.branch, s.changeId, s.band?.triageId])).toEqual(
      expect.arrayContaining([
        ["propose", "HEADLESS", "sdlc/maintain/p95_latency_ms", "", "TRI-0044"],
        ["diagnose", "HEADLESS", "sdlc/maintain/error_rate_pct", "", "TRI-0045"],
      ]),
    );
    // the fake harness finishes; the jobs close and the band-record jobs run (nothing reported → skipped)
    await waitFor(() => h.jobs.list().filter((j) => j.kind === "band-record").length === 2 && h.jobs.list().every((j) => j.state !== "running"));
    const kinds = h.jobs.list().map((j) => [j.kind, j.state]);
    expect(kinds).toEqual(expect.arrayContaining([["propose", "done"], ["diagnose", "done"], ["band-record", "skipped"]]));
    expect(h.jobs.list().find((j) => j.kind === "band-record")?.note).toContain("reported nothing");
    // the harness got the tier's tools as its allowlist (the args file holds whichever session exited last)
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("mcp__sdlc__report_diagnosis");
    expect(args).toContain("--permission-mode");
    // the propose session: the 2σ tools, the diagnosis tool, the PR route's git tools and run_runbook; the diagnose session only the 2σ tools + report_diagnosis
    const contextOf = (kind: string) => {
      const s = sessions.find((x) => x.kind === kind);
      if (!s) throw new Error(`no ${kind} session`);
      return JSON.parse(readFileSync(join(s.worktreePath, ".sdlc-state/sessions", s.id, "context.json"), "utf8")) as { allowedTools: string[]; tier: number; triage: string };
    };
    expect(contextOf("propose")).toMatchObject({ tier: 3, triage: "TRI-0044", allowedTools: expect.arrayContaining(["Bash(gh run view *)", "mcp__sdlc__report_diagnosis", "mcp__sdlc__run_runbook", "Bash(git commit *)"]) });
    expect(contextOf("diagnose")).toMatchObject({ tier: 2, triage: "TRI-0045", allowedTools: ["Read", "Grep", "mcp__sdlc__report_diagnosis"] });
    const bandAt = (i: number) => {
      const b = before.bands?.metrics[i];
      if (!b) throw new Error(`band ${i}`);
      return b;
    };
    expect(bandTools(bandAt(0), 3)).toEqual(["Read", "Grep", "Bash(gh run view *)", "mcp__sdlc__report_diagnosis", "Edit", "Write", "Bash(git add *)", "Bash(git commit *)", "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)", "mcp__sdlc__run_runbook"]);
    expect(bandTools(bandAt(1), 2)).toEqual(["Read", "Grep", "mcp__sdlc__report_diagnosis"]);
    const propose = sessions.find((s) => s.kind === "propose");
    if (!propose) throw new Error("no propose session");
    const mcp = JSON.parse(readFileSync(join(propose.worktreePath, ".sdlc-state/sessions", propose.id, "mcp.json"), "utf8")) as { mcpServers: { sdlc: { env: Record<string, string> } } };
    expect(mcp.mcpServers.sdlc.env).toMatchObject({ SDLC_SESSION: propose.id, SDLC_ACTOR_TYPE: "agent", SDLC_BAND: "p95_latency_ms", SDLC_BAND_TIER: "3", SDLC_TRIAGE: "TRI-0044" });
    const prompt = readFileSync(join(propose.worktreePath, ".sdlc-state/sessions", propose.id, "prompt.md"), "utf8");
    expect(prompt).toContain("3σ propose session");
    expect(prompt).toContain("mcp__sdlc__run_runbook (ids: rollback)");
    expect(prompt).toContain("TRI-0044");

    // idempotent: the same breach again → the open items dedupe, no new TRI, no new job
    const again = await h.engine.detect();
    expect(again.raised).toEqual([]);
    expect(again.jobs).toEqual([]);
    expect((await repoAt(dir)).triage.filter((t) => t.data.status === "open").map((t) => t.data.id)).toEqual(["TRI-0043", "TRI-0044", "TRI-0045"]);
    expect(h.jobs.list().filter((j) => j.kind === "propose" || j.kind === "diagnose")).toHaveLength(2);
    expect(readSnapshots(dir)["p95_latency_ms"]).toHaveLength(2);
    cleanups.push(() => new Promise((r3) => setTimeout(r3, 300)));
  }, 40_000);

  it("1σ is logged only; no engine launching (autoLaunch off) still raises the item and records the job as skipped", async () => {
    const dir = await seeded();
    const lines: string[] = [];
    const h = harness(dir, sources({ p95: "355", errors: "0.62" }), false);
    h.engine.close();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list(), snapshots: () => readSnapshots(dir) });
    const engine = new Engine({ store, registry, jobs: new JobStore(registry.database), sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: sources({ p95: "355", errors: "0.62" }), autoLaunch: false, log: (l) => lines.push(l) });
    cleanups.push(() => engine.close());
    await store.refresh();
    const r = await engine.detect();
    expect(r.pass?.results.map((x) => x.snapshot.tier)).toEqual([1, 2]);
    expect(lines.some((l) => l.includes("p95_latency_ms 1σ") && l.includes("logged"))).toBe(true);
    expect(r.raised.map((x) => x.metric)).toEqual(["error_rate_pct"]);
    expect(r.jobs.map((j) => [j.kind, j.state])).toEqual([["diagnose", "skipped"]]);
    expect(r.jobs[0]?.note).toContain("needs sdlc serve --engine");
    expect(registry.list()).toEqual([]);
    expect((await repoAt(dir)).triage.some((t) => t.data.src === "metric:error_rate_pct" && t.data.status === "open")).toBe(true);
  }, 20_000);

  it("a finished session's diagnosis and runbook runs land on the triage item as RBK records; a propose commit on the branch is noted", async () => {
    const dir = await seeded();
    const h = harness(dir, sources({ errors: "0.41" }), true, { FAKE_CLAUDE_SLEEP: "2" });
    await h.store.refresh();
    const r = await h.engine.detect();
    expect(r.raised.map((x) => x.id)).toEqual(["TRI-0044"]);
    const session = h.registry.list().find((s) => s.kind === "propose");
    if (!session) throw new Error("no propose session");
    // while the harness runs: what report_diagnosis and run_runbook would have written, and a commit on the session's branch (the pr route)
    writeDiagnosisDraft(session.worktreePath, session.id, { metric: "p95_latency_ms", title: "Export p95 regressed after the CSV streaming change", problem: "src/export/csv.ts does a per-row lookup since 4f2a.", proposedOutcome: "p95 under 400 ms with the same CSV.", affected: "Finance; export API.", openQuestions: "Index on (month, customer)?", ts: "2026-09-08T10:20:00Z" });
    appendRunbookRun(session.worktreePath, session.id, { runbook: "rollback", command: "echo rollback: previous release redeployed", metric: "p95_latency_ms", startedAt: "2026-09-08T10:20:00Z", finishedAt: "2026-09-08T10:20:01Z", exitCode: 0, output: "rollback: previous release redeployed\n" });
    writeFileSync(join(session.worktreePath, "src-fix.txt"), "batch the lookup\n");
    await git(session.worktreePath, ["add", "src-fix.txt"]);
    await git(session.worktreePath, ["commit", "-q", "-m", "sdlc(TRI-0044): batch the lookup"]);
    await waitFor(() => h.jobs.list().some((j) => j.kind === "band-record" && j.state !== "running"));
    const record = h.jobs.list().find((j) => j.kind === "band-record");
    expect(record?.state).toBe("done");
    expect(record?.note).toContain('diagnosis "Export p95 regressed after the CSV streaming change"');
    expect(record?.note).toContain("runbooks RBK-0001");
    expect(record?.note).toContain("branch sdlc/maintain/p95_latency_ms");
    const after = await repoAt(dir);
    const item = after.triage.find((t) => t.data.id === "TRI-0044");
    expect(item?.data).toMatchObject({ title: "Export p95 regressed after the CSV streaming change", session: session.id, status: "open", tier: "3σ" });
    expect(item?.data.evidence).toContain("842"); // detection evidence stays
    expect(item?.body).toContain("src/export/csv.ts does a per-row lookup since 4f2a.");
    expect(item?.body).toContain("- rollback (exit 0) at 2026-09-08T10:20:01Z");
    expect(item?.body).toContain("branch sdlc/maintain/p95_latency_ms");
    expect(after.runbookRuns).toHaveLength(1);
    expect(after.runbookRuns[0]).toMatchObject({ id: "RBK-0001", runbook: "rollback", triage: "TRI-0044", session: session.id, actor: { type: "agent", id: "claude-code@sdlc.local" }, output: "rollback: previous release redeployed\n" });
    expect(existsSync(join(dir, "sdlc/loop/runbooks/RBK-0001.json"))).toBe(true);
    const log = await git(dir, ["log", "-1", "--format=%an <%ae>%n%B"]);
    expect(log).toContain("sdlc-bot <sdlc-bot@sdlc.local>");
    expect(log).toContain(`SDLC-Session: ${session.id}`);
    expect(log).toContain("SDLC-Actor: agent:claude-code@sdlc.local");
    // main itself carries no code from the session: the proposal stays on its branch for the code owner
    expect(existsSync(join(dir, "src-fix.txt"))).toBe(false);
    expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    cleanups.push(() => new Promise((r3) => setTimeout(r3, 300)));
  }, 40_000);

  it("POST /api/detect runs a pass through the engine and the snapshot carries bandStatus and runbookRuns; without an engine it is refused", async () => {
    const dir = await seeded();
    const server = await startServer({ cwd: dir, identity: ENG, watch: false, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, engine: false });
    cleanups.push(() => server.close());
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as { bandStatus: { metric: string; status: string }[]; runbookRuns: unknown[] };
    expect(state.bandStatus.map((b) => b.status)).toEqual(["no data · detection has not run", "no data · detection has not run", "no source · add `source:` to bands.yaml"]);
    expect(state.runbookRuns).toEqual([]);
    // the engine (without autoLaunch) measures for real: the seed has no scripts/, so the sources fail and the rows say so
    const r = (await (await fetch(`${server.url}/api/detect`, { method: "POST" })).json()) as { ok: boolean; toast: string; pass: { results: { snapshot: { current: number | null } }[] } };
    expect(r.ok).toBe(true);
    expect(r.toast).toContain("2 bands measured");
    expect(r.pass.results.map((x) => x.snapshot.current)).toEqual([null, null]);
    const after = (await (await fetch(`${server.url}/api/state`)).json()) as { bandStatus: { status: string }[] };
    expect(after.bandStatus[0]?.status).toMatch(/^no data · since .* \(source exit \d+\)$/);
    const bare = await startServer({ cwd: dir, identity: ENG, watch: false });
    cleanups.push(() => bare.close());
    expect((await fetch(`${bare.url}/api/detect`, { method: "POST" })).status).toBe(409);
  }, 30_000);

  it("a band session with a lockfile installs before the harness (CHG-0007): the record carries install and the band worktree has install.log", async () => {
    const dir = await seeded();
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await git(dir, ["add", "pnpm-lock.yaml"]);
    await git(dir, ["commit", "-q", "-m", "chore: lockfile"]);
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const band = (await repoAt(dir)).bands?.metrics.find((b) => b.metric === "error_rate_pct");
    if (!band?.source) throw new Error("the seed's 2σ band is missing");
    const ts = "2026-09-08T10:00:00Z";
    const snapshot: MetricSnapshot = { schema: 1, metric: band.metric, ts, baseline: band.baseline, current: 0.62, sigma: band.sigma ?? null, tier: 2, breached: true, source: { command: band.source, exitCode: 0, output: "0.62" } };
    const job = `band:${band.metric}:2σ:${ts}`;
    const status: BandStatus = { metric: band.metric, baseline: band.baseline, unit: band.unit ?? null, source: band.source, current: 0.62, sigma: band.sigma ?? null, tier: 2, breached: true, action: "diagnose", ts, samples: 0, status: "", triage: ["TRI-0042"], job };
    const calls: [string, string][] = [];
    const exec: Exec = (cmd, cwd) => {
      calls.push([cmd, cwd]);
      return Promise.resolve({ exitCode: 0, output: "Done in 0.2s\n" });
    };
    // the engine does not take an exec for sessions (production runs the real manager): the launcher is called directly
    const r = await launchBandSession({ band, snapshot, tier: 2, triageId: "TRI-0042", job, status, history: [] }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, defaultBranch: "main", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, exec });
    const wt = worktreePathFor(dir, "sdlc/maintain/error_rate_pct");
    expect(calls).toEqual([["pnpm install --frozen-lockfile --prefer-offline", wt]]);
    expect(r.session.install).toMatchObject({ manager: "pnpm", exitCode: 0, output: "Done in 0.2s\n" });
    expect(readFileSync(join(wt, ".sdlc-state", "sessions", r.session.id, "install.log"), "utf8")).toBe("Done in 0.2s\n");
    await r.finished;
    expect(registry.get(r.session.id)).toMatchObject({ install: { manager: "pnpm", exitCode: 0 } });
  }, 20_000);
});

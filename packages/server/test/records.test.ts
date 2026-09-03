import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo, pendingWritebacks, writebacksInState } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { ActionError, ConnectorError, Engine, JobStore, SessionRegistry, StateStore, acceptGate, connectorSpec, linkRecordAction, retryWritebackAction, type RecordsConnector, type WritebackDeps, type WritebackPayload } from "../src/index.js";

const FAKE_CONNECTOR = fileURLToPath(new URL("./fixtures/fake-connector.mjs", import.meta.url));
const OWNER = { id: PO, name: "Priya Owens" };
const NOW = () => new Date("2026-09-04T09:00:00Z");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The seed with `records.intent` switched to `mode` (the seed's incident stays external). */
async function seeded(mode: "external" | "linked", opts: { connector?: boolean } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-records-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", OWNER);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfgPath = join(dir, "sdlc/config.yaml");
  let cfg = readFileSync(cfgPath, "utf8").replace("intent: repo", `intent: ${mode}`);
  if (opts.connector === false) cfg = cfg.replace("  connector: records\n", "");
  writeFileSync(cfgPath, cfg);
  // the seed's CHG-0012 and CHG-0017 carry records: with intent outside repo mode they would owe write-backs too — this suite watches CHG-0022 alone
  for (const id of ["CHG-0012", "CHG-0017"]) {
    const c = join(dir, `sdlc/changes/${id}/change.yaml`);
    const stripped = readFileSync(c, "utf8").replace(/record:\n(?: {2}.*\n)+/, "record: null\n");
    expect(stripped).toContain("record: null");
    writeFileSync(c, stripped);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

/** `.mcp.json` pointing `records` at the stdio fake — the real client path, used once. */
function stdioConnector(dir: string, env: Record<string, string>): void {
  writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify({ mcpServers: { sdlc: { command: "sdlc", args: ["mcp"] }, records: { command: process.execPath, args: [FAKE_CONNECTOR], env } } }, null, 2)}\n`);
}

/** An in-process connector with the same contract: cheap, so the other cases do not spawn a process per call. */
function stub(): { connector: RecordsConnector; calls: Record<string, unknown>[]; fail: boolean } {
  const state = {
    calls: [] as Record<string, unknown>[],
    fail: false,
    connector: {
      name: "records",
      get(system: string, id: string) {
        state.calls.push({ tool: "record_get", system, id });
        return Promise.resolve({ id, url: `https://records.example/${system}/${id}`, title: `Record ${id}` });
      },
      writeBack(payload: WritebackPayload) {
        state.calls.push({ tool: "record_write_back", ...payload });
        if (state.fail) return Promise.reject(new ConnectorError("record_write_back on records: connector unavailable (503 from the records API)"));
        return Promise.resolve({ url: `https://records.example/${payload.system}/${payload.id}#${payload.kind}-${payload.sha.slice(0, 7)}` });
      },
    } satisfies RecordsConnector,
  };
  return state;
}

function harness(dir: string, writeback: WritebackDeps, retryMs = 3_600_000) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: OWNER, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: OWNER, autoLaunch: false, writeback, writebackRetryMs: retryMs, now: NOW });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const fileCalls = (log: string): Record<string, unknown>[] => {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

async function ledger(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(`${id} missing`);
  return { repo, files, view: deriveChange(repo, files), events: files.events.filter((e) => e.event.startsWith("record.")) };
}

const jobsOf = (h: ReturnType<typeof harness>, state?: string) => h.jobs.list().filter((j) => j.kind === "record-writeback" && (state === undefined || j.state === state));

describe("records write-back (2.9, FR-16): external and linked modes through the MCP connector", () => {
  it("external, over the real stdio client: linking verifies the record through the connector; the engine writes back the intent commit and, after the accept, the decision — each once, by sdlc-bot, with the accepting human named", async () => {
    const dir = await seeded("external");
    const log = join(dir, "connector.log");
    stdioConnector(dir, { FAKE_CONNECTOR_LOG: log });
    expect(connectorSpec(dir, "records")?.command).toBe(process.execPath);
    expect(() => connectorSpec(dir, "nope")).toThrow("no mcpServers.nope");
    const h = harness(dir, { attempts: 2, backoffMs: 5, now: NOW });
    await h.store.refresh(true);
    const before = await ledger(dir, "CHG-0022");
    expect(before.view.docs[0].record).toMatchObject({ mode: "external", chip: null, writeback: null });
    expect(pendingWritebacks(before.repo)).toEqual([]);

    const linked = await linkRecordAction(h.store, "CHG-0022", { system: "jira", id: "INV-22" });
    expect(linked.toast).toBe("CHG-0022 linked to jira INV-22 · verified");
    expect(fileCalls(log)[0]).toEqual({ tool: "record_get", system: "jira", id: "INV-22" });
    const afterLink = await ledger(dir, "CHG-0022");
    expect(afterLink.view.record).toEqual({ system: "jira", id: "INV-22", url: "https://records.example/jira/INV-22" });

    // the intent commit was owed as soon as the record existed: the store change ticked the engine
    await waitFor(() => jobsOf(h, "done").length === 1);
    const afterCommit = await ledger(dir, "CHG-0022");
    const sha = afterCommit.view.docs[0].sha ?? "";
    expect(afterCommit.events.map((e) => [e.event, e.actor.id, e.data])).toEqual([
      ["record.linked", PO, { system: "jira", id: "INV-22", url: "https://records.example/jira/INV-22" }],
      ["record.writeback.ok", "sdlc-bot", { system: "jira", id: "INV-22", artifact: 0, kind: "committed", sha, url: `https://records.example/jira/INV-22#committed-${sha.slice(0, 7)}` }],
    ]);
    expect(afterCommit.view.docs[0].record).toMatchObject({ syncedAt: "2026-09-04T09:00:00Z", writeback: { kind: "committed", state: "ok" } });
    expect(fileCalls(log).find((c) => c["tool"] === "record_write_back")).toMatchObject({ system: "jira", id: "INV-22", changeId: "CHG-0022", title: "Multi-currency invoice totals", artifact: 0, artifactName: "intent", kind: "committed", sha, by: "claude-code", at: "2026-09-04T09:00:00Z", url: "https://records.example/jira/INV-22" });

    // the accept stands on its own; the write-back of the decision follows it
    const accepted = await acceptGate(h.store, "CHG-0022", 1);
    expect(accepted.snapshot.changes.find((c) => c.id === "CHG-0022")?.stage).toBe(2);
    await waitFor(() => jobsOf(h, "done").length === 2);
    const afterAccept = await ledger(dir, "CHG-0022");
    expect(afterAccept.events.map((e) => [e.event, (e.data as { kind?: string }).kind]).slice(2)).toEqual([["record.writeback.ok", "accepted"]]);
    expect(fileCalls(log).filter((c) => c["tool"] === "record_write_back").map((c) => [c["kind"], c["by"]])).toEqual([["committed", "claude-code"], ["accepted", PO]]);
    expect(pendingWritebacks(afterAccept.repo)).toEqual([]);
    expect(h.jobs.get(`writeback:CHG-0022:0:accepted:${sha.slice(0, 7)}`)).toMatchObject({ kind: "record-writeback", state: "done", note: `intent.md accepted ${sha.slice(0, 7)} → jira INV-22 · attempt 1` });
    // an idle tick claims nothing new
    await h.engine.tick();
    expect(jobsOf(h)).toHaveLength(2);
  }, 60_000);

  it("external: a dead connector leaves the accept accepted and records one failure after the attempts; the retry action runs it now — 502 retryable while it keeps failing, ok once it lands", async () => {
    const dir = await seeded("external");
    const fake = stub();
    fake.fail = true;
    const deps: WritebackDeps = { connector: () => fake.connector, attempts: 2, backoffMs: 5, now: NOW };
    const h = harness(dir, deps);
    await h.store.refresh(true);
    await linkRecordAction(h.store, "CHG-0022", { system: "jira", id: "INV-22", url: "https://jira.example/browse/INV-22" }, deps);
    await waitFor(() => jobsOf(h, "failed").length === 1);
    const failed = await ledger(dir, "CHG-0022");
    expect(failed.events.map((e) => e.event)).toEqual(["record.linked", "record.writeback.failed"]);
    expect(failed.events[1]?.data).toMatchObject({ system: "jira", id: "INV-22", artifact: 0, kind: "committed", error: "record_write_back on records: connector unavailable (503 from the records API)" });
    expect(failed.view.docs[0].record.writeback).toMatchObject({ kind: "committed", state: "failed" });
    expect(failed.view.activity[0]?.text).toContain("failed · retry");
    expect(writebacksInState(failed.repo, "failed")).toHaveLength(1);
    expect(fake.calls.filter((c) => c["tool"] === "record_write_back")).toHaveLength(2); // two attempts
    expect(jobsOf(h)[0]?.note).toContain("2 attempts · retry");

    // still failing: the retry reports, the ledger keeps its single failure
    const again = await retryWritebackAction(h.store, "CHG-0022", 0, deps).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ActionError);
    expect((again as ActionError).status).toBe(502);
    expect((again as ActionError).retryable).toBe(true);
    expect((again as ActionError).message).toMatch(/^CHG-0022: write-back of intent\.md committed [0-9a-f]{7} to jira INV-22 failed · retry \(/);
    expect((await ledger(dir, "CHG-0022")).events).toHaveLength(2);

    // the connector is back: the retry lands and the artifact reads synced
    fake.fail = false;
    const ok = await retryWritebackAction(h.store, "CHG-0022", 0, deps);
    expect(ok.toast).toMatch(/^CHG-0022: intent\.md committed [0-9a-f]{7} written to jira INV-22 · synced$/);
    expect(ok.run).toMatchObject({ ok: true, attempts: 1 });
    h.engine.noteWriteback(ok.run);
    const landed = await ledger(dir, "CHG-0022");
    expect(landed.events.map((e) => e.event)).toEqual(["record.linked", "record.writeback.failed", "record.writeback.ok"]);
    expect(landed.view.docs[0].record).toMatchObject({ syncedAt: "2026-09-04T09:00:00Z", writeback: { state: "ok" } });
    expect(jobsOf(h)[0]?.state).toBe("done");
    expect(await retryWritebackAction(h.store, "CHG-0022", 0, deps).catch((e: unknown) => (e as ActionError).message)).toContain("nothing to write back");
  }, 60_000);

  it("external: a failed write-back is retried on ticks after the retry gap, silently until it lands; without a connector the failure names the missing config and validation warns", async () => {
    const dir = await seeded("external");
    const fake = stub();
    fake.fail = true;
    const deps: WritebackDeps = { connector: () => fake.connector, attempts: 1, now: NOW };
    const h = harness(dir, deps, 0);
    await h.store.refresh(true);
    await linkRecordAction(h.store, "CHG-0022", { system: "jira", id: "INV-22", url: "https://jira.example/browse/INV-22" }, deps);
    await waitFor(() => jobsOf(h, "failed").length === 1);
    await h.engine.tick();
    await h.engine.tick();
    // every tick past the gap re-tries (the store's own refresh after the failure ticks too); the ledger records the failure once
    expect(fake.calls.filter((c) => c["tool"] === "record_write_back").length).toBeGreaterThanOrEqual(3);
    expect(jobsOf(h)).toHaveLength(1);
    expect((await ledger(dir, "CHG-0022")).events.filter((e) => e.event === "record.writeback.failed")).toHaveLength(1);
    fake.fail = false;
    await h.engine.tick();
    await waitFor(() => jobsOf(h, "done").length === 1);
    expect((await ledger(dir, "CHG-0022")).events.map((e) => e.event)).toEqual(["record.linked", "record.writeback.failed", "record.writeback.ok"]);

    const bare = await seeded("external", { connector: false });
    const b = harness(bare, { now: NOW });
    await b.store.refresh(true);
    expect(b.store.current?.validation.diagnostics.map((d) => d.rule)).toContain("records.connector-missing");
    const r = await linkRecordAction(b.store, "CHG-0022", { system: "jira", id: "INV-22" });
    expect(r.toast).toBe("CHG-0022 linked to jira INV-22");
    await waitFor(() => jobsOf(b, "failed").length === 1);
    expect(jobsOf(b)[0]?.error).toContain("records.connector is not set");
    expect((await ledger(bare, "CHG-0022")).events.map((e) => e.event)).toEqual(["record.linked", "record.writeback.failed"]);
  }, 60_000);

  it("linked: the gate refuses until the record carries the intent commit; a failed write-back is named in the block, the healed retry lifts it and the accept goes through", async () => {
    const dir = await seeded("linked");
    const fake = stub();
    fake.fail = true;
    const deps: WritebackDeps = { connector: () => fake.connector, attempts: 1, now: NOW };
    const h = harness(dir, deps, 0);
    await h.store.refresh(true);
    const noRecord = await acceptGate(h.store, "CHG-0022", 1).catch((e: unknown) => e as ActionError);
    expect((noRecord as ActionError).diagnostics[0]?.rule).toBe("gate.linked.record-missing");
    expect(h.store.current?.changes.find((c) => c.id === "CHG-0022")?.recordBlock).toContain("link the record first");

    await linkRecordAction(h.store, "CHG-0022", { system: "jira", id: "INV-22" }, deps);
    await waitFor(() => jobsOf(h, "failed").length === 1);
    const blocked = await acceptGate(h.store, "CHG-0022", 1).catch((e: unknown) => e as ActionError);
    expect((blocked as ActionError).status).toBe(409);
    expect((blocked as ActionError).diagnostics[0]?.rule).toBe("gate.linked.sha-not-written");
    expect((blocked as ActionError).message).toContain("write-back failed: record_write_back on records: connector unavailable");
    const view = h.store.current?.changes.find((c) => c.id === "CHG-0022");
    expect(view?.recordBlock).toMatch(/^Accept is blocked until jira INV-22 carries commit [0-9a-f]{7} — write-back failed · retry \(record_write_back on records/);
    expect(view?.docs[0].authoritative).toBe(false);
    expect(view?.docs[0].record.mode).toBe("linked");

    fake.fail = false;
    await h.engine.tick();
    await waitFor(() => jobsOf(h, "done").length === 1);
    expect(h.store.current?.changes.find((c) => c.id === "CHG-0022")?.recordBlock).toBeNull();
    const accepted = await acceptGate(h.store, "CHG-0022", 1);
    expect(accepted.snapshot.changes.find((c) => c.id === "CHG-0022")?.stage).toBe(2);
    await waitFor(() => jobsOf(h, "done").length === 2);
    const done = await ledger(dir, "CHG-0022");
    expect(done.events.map((e) => [e.event, (e.data as { kind?: string }).kind ?? null])).toEqual([["record.linked", null], ["record.writeback.failed", "committed"], ["record.writeback.ok", "committed"], ["record.writeback.ok", "accepted"]]);
    expect(pendingWritebacks(done.repo)).toEqual([]);
  }, 60_000);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { PO, realizeSeedRepro, writeSeed } from "@sdlc/fixtures";
import { verifyChangeExport } from "@sdlc/core";
import type { ChangeExport } from "@sdlc/schemas";
import { Engine, JobStore, OtlpTracer, SessionRegistry, StateStore, launchSession, noopTracer, otlpRequest, parseOtlpHeaders, startServer, traceUrlFor, tracerFromEnv, type Exec } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  events: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[];
  status: { code: number; message?: string };
}

interface Receiver {
  url: string;
  spans: OtlpSpan[];
  requests: { path: string; headers: Record<string, string | string[] | undefined>; serviceName: string | undefined }[];
  /** Make the receiver answer 500 (export failure); reset with `fail(false)`. */
  fail: (on: boolean) => void;
  close: () => Promise<void>;
}

/** A fake OTLP/HTTP receiver: collects every span posted to /v1/traces. */
function startReceiver(): Promise<Receiver> {
  const spans: OtlpSpan[] = [];
  const requests: Receiver["requests"] = [];
  let failing = false;
  const server: Server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => {
      if (failing) {
        res.writeHead(500);
        res.end("nope");
        return;
      }
      const body = JSON.parse(data) as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] }; scopeSpans: { spans: OtlpSpan[] }[] }[] };
      const serviceName = body.resourceSpans[0]?.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue;
      requests.push({ path: req.url ?? "", headers: req.headers, serviceName });
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, spans, requests, fail: (on) => (failing = on), close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const attr = (s: OtlpSpan, key: string): unknown => {
  const v = s.attributes.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  if ("stringValue" in v) return v["stringValue"];
  if ("intValue" in v) return Number(v["intValue"]);
  if ("doubleValue" in v) return v["doubleValue"];
  if ("boolValue" in v) return v["boolValue"];
  return v;
};

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-otel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

describe("OtlpTracer (no OpenTelemetry SDK: OTLP/HTTP JSON over fetch)", () => {
  it("exports finished spans with parent/child relations, attributes, events and status; the no-op tracer exports nothing and has no ids", async () => {
    const rx = await startReceiver();
    cleanups.push(() => rx.close());
    const lines: string[] = [];
    const tracer = new OtlpTracer({ url: `${rx.url}/v1/traces`, headers: { authorization: "Bearer t0k" }, serviceName: "sdlc-test", intervalMs: 0, log: (l) => lines.push(l) });
    const parent = tracer.startSpan("sdlc.job", { attributes: { "sdlc.job.kind": "per-change-run", "sdlc.cycle": 1, "sdlc.run.pass_rate": 0.5, "sdlc.flag": true, "sdlc.none": null } });
    const child = tracer.startSpan("sdlc.run.per-change", { parent });
    child.addEvent("sdlc.run.command", { "sdlc.command.name": "test", "sdlc.command.pass": false });
    child.end({ ok: false, message: "red" });
    parent.end({ ok: true });
    expect(tracer.pending).toBe(2);
    await tracer.flush();
    expect(tracer.pending).toBe(0);
    expect(rx.requests.map((r) => [r.path, r.headers["authorization"], r.serviceName])).toEqual([["/v1/traces", "Bearer t0k", "sdlc-test"]]);
    const byName = new Map(rx.spans.map((s) => [s.name, s]));
    const job = byName.get("sdlc.job");
    const run = byName.get("sdlc.run.per-change");
    if (!job || !run) throw new Error("spans missing");
    expect(job.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(job.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(job.parentSpanId).toBeUndefined();
    expect(run.traceId).toBe(job.traceId);
    expect(run.parentSpanId).toBe(job.spanId);
    expect(attr(job, "sdlc.job.kind")).toBe("per-change-run");
    expect(attr(job, "sdlc.cycle")).toBe(1);
    expect(attr(job, "sdlc.run.pass_rate")).toBe(0.5);
    expect(attr(job, "sdlc.flag")).toBe(true);
    expect(job.attributes.find((a) => a.key === "sdlc.none")).toBeUndefined();
    expect(job.status).toEqual({ code: 1 });
    expect(run.status).toEqual({ code: 2, message: "red" });
    expect(run.events.map((e) => e.name)).toEqual(["sdlc.run.command"]);
    expect(BigInt(run.endTimeUnixNano) >= BigInt(run.startTimeUnixNano)).toBe(true);
    expect(lines).toEqual([]);

    const nope = noopTracer.startSpan("x");
    expect(nope.traceId).toBeNull();
    expect(nope.context()).toBeNull();
    nope.end();
    await noopTracer.flush();
    await tracer.shutdown();
  });

  it("an export failure is logged once, drops the batch and never throws; recovery logs nothing more until it fails again", async () => {
    const rx = await startReceiver();
    cleanups.push(() => rx.close());
    const lines: string[] = [];
    const tracer = new OtlpTracer({ url: `${rx.url}/v1/traces`, intervalMs: 0, log: (l) => lines.push(l) });
    rx.fail(true);
    tracer.startSpan("a").end();
    await tracer.flush();
    tracer.startSpan("b").end();
    await tracer.flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("trace export to");
    expect(lines[0]).toContain("dropped");
    rx.fail(false);
    tracer.startSpan("c").end();
    await tracer.flush();
    expect(rx.spans.map((s) => s.name)).toEqual(["c"]);
    rx.fail(true);
    tracer.startSpan("d").end();
    await tracer.flush();
    expect(lines).toHaveLength(2);
    // a dead endpoint (connection refused) is the same story
    const dead = new OtlpTracer({ url: "http://127.0.0.1:1/v1/traces", intervalMs: 0, log: (l) => lines.push(l) });
    dead.startSpan("e").end();
    await expect(dead.flush()).resolves.toBeUndefined();
    expect(lines).toHaveLength(3);
    await tracer.shutdown();
  });

  it("tracerFromEnv reads the OTel variables; headers and trace URL templates parse as the spec says", () => {
    expect(tracerFromEnv({}).enabled).toBe(false);
    expect(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }).enabled).toBe(false);
    const t = tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/", OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc, x-tenant=acme", OTEL_SERVICE_NAME: "console-1" }, { intervalMs: 0 });
    expect(t.enabled).toBe(true);
    expect((t as OtlpTracer)["opts"]).toMatchObject({ url: "http://collector:4318/v1/traces", headers: { authorization: "Bearer abc", "x-tenant": "acme" }, serviceName: "console-1" });
    const explicit = tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://other:4318/custom/traces" }, { intervalMs: 0 });
    expect((explicit as OtlpTracer)["opts"]).toMatchObject({ url: "http://other:4318/custom/traces", serviceName: "sdlc-console" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("bad,=x,k=")).toEqual({ k: "" });
    expect(traceUrlFor("https://jaeger.example/trace/{traceId}", "abc")).toBe("https://jaeger.example/trace/abc");
    expect(traceUrlFor("https://tempo.example/?id=", "abc")).toBe("https://tempo.example/?id=abc");
    expect(traceUrlFor(undefined, "abc")).toBeNull();
    expect(traceUrlFor("x", null)).toBeNull();
    const req = otlpRequest("svc", []) as { resourceSpans: { scopeSpans: { scope: { name: string }; spans: unknown[] }[] }[] };
    expect(req.resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({ name: "sdlc-console" });
  });
});

describe("spans for sessions, jobs and runs (3.3)", () => {
  it("a headless session is one sdlc.session span with the ledger commits as events; its trace id is on the registry record", async () => {
    const rx = await startReceiver();
    cleanups.push(() => rx.close());
    const tracer = new OtlpTracer({ url: `${rx.url}/v1/traces`, intervalMs: 0 });
    const dir = await seeded();
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const r = await launchSession({ changeId: "CHG-0022" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, tracer });
    expect(r.session.traceId).toMatch(/^[0-9a-f]{32}$/);
    await r.finished;
    await tracer.flush();
    const span = rx.spans.find((s) => s.name === "sdlc.session");
    if (!span) throw new Error("no session span");
    expect(span.traceId).toBe(r.session.traceId);
    expect(span.spanId).toBe(r.session.spanId);
    expect(span.parentSpanId).toBeUndefined();
    expect(attr(span, "sdlc.session.id")).toBe(r.session.id);
    expect(attr(span, "sdlc.session.kind")).toBe("intent");
    expect(attr(span, "sdlc.session.mode")).toBe("HEADLESS");
    expect(attr(span, "sdlc.change")).toBe("CHG-0022");
    expect(attr(span, "sdlc.session.status")).toBe("done");
    expect(attr(span, "sdlc.session.exit_code")).toBe(0);
    expect(attr(span, "sdlc.session.cost_usd")).toBe(0.12);
    expect(attr(span, "sdlc.session.model")).toBe("fake-model");
    expect(span.status).toEqual({ code: 1 });
    expect(span.events.map((e) => e.name)).toEqual(["sdlc.ledger.session.started", "sdlc.ledger.session.stopped"]);
    for (const e of span.events) expect(e.attributes.find((a) => a.key === "sdlc.commit")?.value["stringValue"]).toMatch(/^[0-9a-f]{40}$/);
    // the registry keeps the id; the snapshot's session rows carry it to the UI
    expect(registry.get(r.session.id)?.traceId).toBe(span.traceId);

    // a resume joins the same trace as a child of the launch span
    const resumed = await launchSession({ changeId: "CHG-0022", kind: "intent", mode: "HEADLESS", resume: { sessionId: r.session.id, guidance: "again" } }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, tracer });
    await resumed.finished;
    await tracer.flush();
    const again = rx.spans.find((s) => s.name === "sdlc.session.resume");
    expect(again?.traceId).toBe(span.traceId);
    expect(again?.parentSpanId).toBe(span.spanId);
    expect(attr(again as OtlpSpan, "sdlc.session.resume_count")).toBe(1);

    // a failing harness ends the span with an error status
    const failing = await launchSession({ changeId: "CHG-0021", kind: "design" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, env: { ...process.env, FAKE_CLAUDE_FAIL: "1" }, tracer });
    await failing.finished;
    await tracer.flush();
    const bad = rx.spans.find((s) => s.name === "sdlc.session" && attr(s, "sdlc.change") === "CHG-0021");
    expect(bad?.status.code).toBe(2);
    expect(attr(bad as OtlpSpan, "sdlc.session.status")).toBe("error");
    await tracer.shutdown();
  }, 30_000);

  it("a per-change run is an sdlc.job span with the sdlc.run.per-change span as its child, the idempotency key and verdict as attributes, and the trace id on the job", async () => {
    const rx = await startReceiver();
    cleanups.push(() => rx.close());
    const tracer = new OtlpTracer({ url: `${rx.url}/v1/traces`, intervalMs: 0 });
    const dir = await seeded();
    const exec: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });
    const registry = new SessionRegistry(dir);
    cleanups.push(() => registry.close());
    const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
    const jobs = new JobStore(registry.database, tracer);
    const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec, autoLaunch: false, tracer, now: () => new Date("2026-09-08T09:00:00Z") });
    cleanups.push(() => engine.close());
    await store.refresh();
    // CHG-0018 is the seed's stage-4 fix: its repro test must be a real commit before the fix (2.7)
    const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, tracer });
    const wt = launched.session.worktreePath;
    await realizeSeedRepro(dir, wt);
    mkdirSync(join(wt, "src/export"), { recursive: true });
    writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
    const job = await engine.runForSession({ ...launched.session, status: "done" });
    if (!job) throw new Error("no job");
    expect(job.state).toBe("done");
    expect(job.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(jobs.get(job.key)?.traceId).toBe(job.traceId);
    expect(jobs.spanOf(job.key)).toBeNull();
    await tracer.flush();
    const jobSpan = rx.spans.find((s) => s.name === "sdlc.job" && attr(s, "sdlc.job.kind") === "per-change-run");
    const runSpan = rx.spans.find((s) => s.name === "sdlc.run.per-change");
    if (!jobSpan || !runSpan) throw new Error("spans missing");
    expect(jobSpan.traceId).toBe(job.traceId);
    expect(attr(jobSpan, "sdlc.job.key")).toBe(job.key);
    expect(attr(jobSpan, "sdlc.change")).toBe("CHG-0018");
    expect(attr(jobSpan, "sdlc.cycle")).toBe(1);
    expect(attr(jobSpan, "sdlc.stage")).toBe(4);
    expect(attr(jobSpan, "sdlc.job.state")).toBe("done");
    expect(attr(jobSpan, "sdlc.job.note")).toBe(job.note);
    expect(jobSpan.status).toEqual({ code: 1 });
    expect(runSpan.traceId).toBe(jobSpan.traceId);
    expect(runSpan.parentSpanId).toBe(jobSpan.spanId);
    expect(attr(runSpan, "sdlc.run.verdict")).toBe("green");
    expect(attr(runSpan, "sdlc.run.commands.passed")).toBe(3);
    expect(attr(runSpan, "sdlc.run.commands.total")).toBe(3);
    expect(attr(runSpan, "sdlc.run.commit")).toMatch(/^[0-9a-f]{40}$/);
    expect(attr(runSpan, "sdlc.run.pr_action")).toBe("opened");
    expect(attr(runSpan, "sdlc.run.n")).toBe(2);
    expect(attr(runSpan, "sdlc.run.cases.total")).toBe(1);
    expect(runSpan.events.filter((e) => e.name === "sdlc.run.command")).toHaveLength(3);
    expect(runSpan.events.filter((e) => e.name === "sdlc.run.case")).toHaveLength(1);
    // the run ended before the job did, inside it
    expect(BigInt(runSpan.startTimeUnixNano) >= BigInt(jobSpan.startTimeUnixNano)).toBe(true);
    expect(BigInt(runSpan.endTimeUnixNano) <= BigInt(jobSpan.endTimeUnixNano)).toBe(true);
    // the SUPERVISED session's span ended when it was prepared
    const sess = rx.spans.find((s) => s.name === "sdlc.session");
    expect(attr(sess as OtlpSpan, "sdlc.session.status")).toBe("awaiting_engineer");

    // the suite run: sdlc.job(evals-run) → sdlc.run.suite with verdict and case counts
    const suite = await engine.runSuite("manual");
    expect(suite.job?.state).toBe("done");
    await tracer.flush();
    const suiteJob = rx.spans.find((s) => s.name === "sdlc.job" && attr(s, "sdlc.job.kind") === "evals-run");
    const suiteRun = rx.spans.find((s) => s.name === "sdlc.run.suite");
    if (!suiteJob || !suiteRun) throw new Error("suite spans missing");
    expect(suiteRun.parentSpanId).toBe(suiteJob.spanId);
    expect(suiteJob.traceId).toBe(suite.job?.traceId);
    expect(attr(suiteRun, "sdlc.run.id")).toBe(suite.outcome?.run?.id);
    expect(attr(suiteRun, "sdlc.run.verdict")).toBe(suite.outcome?.run?.verdict);
    expect(attr(suiteRun, "sdlc.run.cases.total")).toBe(suite.outcome?.run?.results.length);
    expect(attr(suiteRun, "sdlc.run.trigger")).toBe("manual");
    // a losing claim (idempotency) starts no span
    const before = rx.spans.length;
    expect(await engine.runForSession({ ...launched.session, status: "done" })).toBeNull();
    await tracer.flush();
    expect(rx.spans.length).toBe(before);
    await tracer.shutdown();
  }, 40_000);

  it("sdlc serve wires one tracer for every product, flushes it on close, and tells the UI the trace URL template; the export route is read-only and hashed", async () => {
    const rx = await startReceiver();
    cleanups.push(() => rx.close());
    const dir = await seeded();
    const server = await startServer({ cwd: dir, identity: ENG, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE, watch: false, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: rx.url, OTEL_TRACE_URL_TEMPLATE: "https://jaeger.example/trace/{traceId}" }, now: () => new Date("2026-09-08T12:00:00Z") });
    cleanups.push(() => server.close());
    expect(server.tracer.enabled).toBe(true);
    const products = (await (await fetch(`${server.url}/api/products`)).json()) as { traceUrlTemplate: string | null };
    expect(products.traceUrlTemplate).toBe("https://jaeger.example/trace/{traceId}");
    const started = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changeId: "CHG-0022" }) });
    expect(started.status).toBe(200);
    const body = (await started.json()) as { session: { id: string; traceId: string | null } };
    expect(body.session.traceId).toMatch(/^[0-9a-f]{32}$/);
    const until = Date.now() + 10_000;
    while (server.registry.get(body.session.id)?.status !== "done" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    server.store.rebuild();
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as { sessions: { id: string; traceId?: string | null }[] };
    expect(state.sessions.find((s) => s.id === body.session.id)?.traceId).toBe(body.session.traceId);

    // compliance export over HTTP: JSON is canonical and hashed; Markdown renders it; the hash is also a header
    const res = await fetch(`${server.url}/api/changes/CHG-0012/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="CHG-0012-export.json"');
    const doc = (await res.json()) as ChangeExport;
    expect(verifyChangeExport(doc)).toBe(true);
    expect(res.headers.get("x-sdlc-content-hash")).toBe(doc.contentHash.value);
    expect(doc.exportedBy).toEqual({ id: ENG.id, name: ENG.name });
    expect(doc.exportedAt).toBe("2026-09-08T12:00:00Z");
    expect(doc.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.cycles.map((c) => [c.cycle, c.archived])).toEqual([[1, false]]);
    // the seed's decisions were committed in one baseline commit without trailers: no commit is claimed for them
    expect(doc.cycles[0]?.decisions.every((d) => d.commit === null)).toBe(true);
    const md = await fetch(`${server.url}/api/changes/CHG-0012/export?format=md&download=0`);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.headers.get("content-disposition")).toBeNull();
    expect(await md.text()).toContain(`\`${doc.contentHash.value}\``);
    expect((await fetch(`${server.url}/api/changes/CHG-0012/export?format=xml`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/changes/CHG-9999/export`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/changes/CHG-0012/export`, { method: "POST" })).status).toBe(404);
    // jobs carry their trace id for the UI
    const jobs = (await (await fetch(`${server.url}/api/jobs`)).json()) as { traceId: string | null }[];
    expect(Array.isArray(jobs)).toBe(true);

    await server.close();
    cleanups.pop();
    expect(rx.spans.map((s) => s.name)).toContain("sdlc.session");
    expect(rx.spans.find((s) => s.name === "sdlc.session")?.traceId).toBe(body.session.traceId);
  }, 30_000);
});

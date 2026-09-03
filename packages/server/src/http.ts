import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { gitRaw } from "@sdlc/adapter-git";
import { readFile, type Tree } from "@sdlc/core";
import { readRounds } from "@sdlc/mcp";
import { parseFrontMatter, type GateNumber } from "@sdlc/schemas";
import { WebSocketServer, type WebSocket } from "ws";
import {
  acceptGate,
  confirmReproTest,
  dismissPrAutoFinding,
  liftTestFreeze,
  rejectReproTest,
  confirmTaskSplit,
  findingDismiss,
  findingEscalate,
  findingPatch,
  findingsImport,
  harvestChange,
  loopChange,
  newChange,
  proposalDismiss,
  sendBackGate,
  triageAccept,
  triageDismiss,
  type ActionResult,
} from "./actions.js";
import type { Engine, JobStore } from "./engine/index.js";
import { receiveWebhook, type DeliveryLog } from "./github/webhooks.js";
import { clearRepro, downgradeSession, launchSession, markReproRejected, reproDraftFor, resumeAfterRepro, stopSession, verifyReproCommit, type LaunchDeps, type LaunchInput, type SessionRegistry } from "./sessions/index.js";
import { ActionError, type StateStore } from "./store.js";

type Body = Record<string, unknown>;

/** Launcher dependencies from the app options; null when sessions cannot be launched here. */
function launchDeps(options: AppOptions, store: StateStore, registry: SessionRegistry | null): LaunchDeps | null {
  if (!registry || !options.sdlcBin) return null;
  return { root: store.root, registry, sdlcBin: options.sdlcBin, identity: store.who, ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}), onExit: (s) => (options.engine ? void options.engine.onSessionExit(s) : store.rebuild()) };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => {
      if (data.trim() === "") return resolve({});
      try {
        const v: unknown = JSON.parse(data);
        resolve(typeof v === "object" && v !== null ? (v as Body) : {});
      } catch (e) {
        reject(new ActionError(400, `invalid JSON body: ${(e as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

/** Raw body for signature checks; refuses more than `limit` bytes. */
function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ActionError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function gateOf(body: Body): GateNumber {
  const n = Number(body["gate"]);
  if (![1, 2, 3, 5, 6].includes(n)) throw new ActionError(400, "gate must be 1, 2, 3, 5 or 6");
  return n as GateNumber;
}

function str(body: Body, key: string, required = true): string {
  const v = body[key];
  if (typeof v === "string" && v.trim() !== "") return v;
  if (required) throw new ActionError(400, `${key} is required`);
  return "";
}

const ARTIFACT_FILES = ["intent.md", "spec.md", "plan.md", "evals", "pr.yaml", "incident.md"];

function artifact(tree: Tree, id: string, index: number): unknown {
  const name = ARTIFACT_FILES[index];
  if (!name) throw new ActionError(400, "artifact index must be 0..5");
  const dir = `sdlc/changes/${id}`;
  if (name === "evals") {
    const files = [...tree.files.keys()].filter((p) => p.startsWith(`${dir}/evals/`)).sort();
    return { index, name, files: files.map((path) => ({ path, body: readFile(tree, path)?.content ?? "" })) };
  }
  const file = readFile(tree, `${dir}/${name}`);
  if (!file) return { index, name, path: `${dir}/${name}`, present: false, body: null, frontMatter: null };
  const split = name.endsWith(".md") ? parseFrontMatter(file.content, `${dir}/${name}`) : null;
  return { index, name, path: `${dir}/${name}`, present: true, sha: file.sha, body: split?.value?.body ?? file.content, frontMatter: split?.value?.data ?? null };
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".map": "application/json" };

/** Serve the built SPA (single view enum, no router: every unknown path gets index.html). */
function serveStatic(webDir: string, url: URL, res: ServerResponse): boolean {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(webDir, rel);
  if (!file.startsWith(webDir)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html");
  if (!existsSync(file)) return false;
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
  return true;
}

export interface AppOptions {
  /** Directory of the built web app; when absent only /api is served. */
  webDir?: string;
  registry?: SessionRegistry;
  sdlcBin?: string;
  claudeBin?: string;
  engine?: Engine;
  jobs?: JobStore;
  /** Processed webhook deliveries (replay guard); the receiver is off without it. */
  deliveries?: DeliveryLog;
  /** Environment for the code host (`GITHUB_TOKEN`) and the webhook receiver (`GITHUB_WEBHOOK_SECRET`). */
  env?: Record<string, string | undefined>;
}

export interface HttpApp {
  server: Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

/** HTTP JSON + WebSocket snapshot transport (blueprint §9.2). */
export function createApp(store: StateStore, options: AppOptions = {}): HttpApp {
  const server = createServer((req, res) => {
    void route(req, res).catch((e: unknown) => {
      if (e instanceof ActionError) {
        json(res, e.status, { error: e.message, diagnostics: e.diagnostics, retryable: e.retryable });
      } else {
        json(res, 500, { error: (e as Error).message });
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/api/events") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      const snap = store.current;
      if (snap) ws.send(JSON.stringify({ type: "snapshot", snapshot: snap }));
    });
  });
  const unsubscribe = store.subscribe((snapshot) => {
    const msg = JSON.stringify({ type: "snapshot", snapshot });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (parts[0] !== "api") {
      if (method === "GET" && options.webDir && serveStatic(options.webDir, url, res)) return;
      throw new ActionError(404, "not found");
    }

    if (method === "GET" && parts[1] === "state" && parts.length === 2) {
      json(res, 200, await store.refresh());
      return;
    }
    if (method === "GET" && parts[1] === "jobs") {
      json(res, 200, options.jobs?.list() ?? []);
      return;
    }
    if (method === "GET" && parts[1] === "health") {
      json(res, 200, { ok: true, revision: store.current?.revision ?? 0 });
      return;
    }
    if (parts[1] === "changes") {
      const id = parts[2];
      if (method === "POST" && !id) {
        const body = await readBody(req);
        const origin = str(body, "origin", false) || "idea";
        const [type, ...ref] = origin.split(":");
        const r = await newChange(store, {
          title: str(body, "title"),
          kind: (body["kind"] as "feature" | "fix" | undefined) ?? "feature",
          risk: (body["risk"] as "routine" | "high" | undefined) ?? "routine",
          origin: ref.length > 0 ? { type: type as "idea", ref: ref.join(":") } : { type: type as "idea" },
          ...(typeof body["intentBody"] === "string" ? { intentBody: body["intentBody"] } : {}),
        });
        reply(res, r);
        return;
      }
      if (!id) throw new ActionError(404, "not found");
      if (method === "GET" && parts.length === 3) {
        const snap = await store.refresh();
        const c = snap.changes.find((x) => x.id === id);
        if (!c) throw new ActionError(404, `${id} not found`);
        json(res, 200, c);
        return;
      }
      if (method === "GET" && parts[3] === "artifacts" && parts[4] !== undefined) {
        await store.refresh();
        const repo = store.currentRepo;
        if (!repo) throw new ActionError(502, "repository not loaded", [], true);
        if (!repo.changes.has(id)) throw new ActionError(404, `${id} not found`);
        json(res, 200, artifact(repo.tree, id, Number(parts[4])));
        return;
      }
      if (method === "GET" && parts[3] === "design" && parts[4] !== undefined && parts.length === 5) {
        // the change's design mock, bytes straight from git (read-only; the console never edits design/)
        await store.refresh();
        const repo = store.currentRepo;
        if (!repo) throw new ActionError(502, "repository not loaded", [], true);
        const path = `sdlc/changes/${id}/design/${parts[4]}`;
        const file = repo.changes.get(id)?.design.find((d) => d.path === path);
        if (!file) throw new ActionError(404, `${path} not found`);
        const blob = await gitRaw(store.root, ["cat-file", "blob", file.sha], { binary: true });
        if (blob.code !== 0) throw new ActionError(404, `${path} not readable`);
        res.writeHead(200, { "content-type": MIME[extname(parts[4]).toLowerCase()] ?? "application/octet-stream", "content-length": blob.buffer.length, "cache-control": "private, max-age=3600" });
        res.end(blob.buffer);
        return;
      }
      if (method !== "POST") throw new ActionError(404, "not found");
      const body = await readBody(req);
      const action = parts.slice(3).join("/");
      switch (action) {
        case "run": {
          if (!options.engine) throw new ActionError(409, "per-change runs need the engine (start the server with sdlcBin)");
          const job = await options.engine.runForChange(id);
          if (!job) throw new ActionError(409, `no build session or task worktree for ${id}`);
          json(res, 200, { ok: true, job, toast: job.state === "failed" ? `run failed: ${job.error ?? ""}` : `${id}: ${job.note ?? job.state}`, revision: store.current?.revision ?? 0 });
          return;
        }
        case "accept":
          reply(res, await acceptGate(store, id, gateOf(body), options.env ?? process.env));
          return;
        case "send-back":
          reply(res, await sendBackGate(store, id, gateOf(body), str(body, "feedback"), options.env ?? process.env));
          return;
        case "loop":
          reply(res, await loopChange(store, id));
          return;
        case "harvest":
          reply(res, await harvestChange(store, id));
          return;
        case "tasks/confirm":
          reply(res, await confirmTaskSplit(store, id, Array.isArray(body["tasks"]) ? (body["tasks"] as never) : undefined));
          return;
        case "repro/confirm": {
          // the session's draft is the default; explicit fields (CLI, a manual repro) override it — the commit is verified by sha either way
          const owner = options.registry ? reproDraftFor(options.registry, id) : null;
          const input = { testPath: str(body, "testPath", false) || owner?.draft.testPath || "", failureReason: str(body, "failureReason", false) || owner?.draft.failureReason || "", sha: str(body, "sha", false) || owner?.draft.sha || "", output: str(body, "output", false) || owner?.draft.output || "" };
          if (!input.testPath || !input.failureReason || !input.sha) throw new ActionError(400, "repro confirm needs testPath, failureReason and sha — or a session that reported the repro test");
          await verifyReproCommit(store.root, input.sha, input.testPath);
          const r = await confirmReproTest(store, id, input);
          let resumed: string | null = null;
          if (owner) {
            clearRepro(owner);
            const s = await resumeAfterRepro(owner, `The engineer confirmed the repro test ${input.testPath} at ${input.sha.slice(0, 7)}: it fails for the right reason. The test freeze is active — fix the code without editing files under the test globs (propose test changes with mcp__sdlc__request_input), run the verification commands, record rounds with mcp__sdlc__report_round, and call mcp__sdlc__report_done when the repro test and everything else are green.`, launchDeps(options, store, options.registry ?? null));
            resumed = s?.id ?? null;
            store.rebuild();
          }
          reply(res, { ...r, toast: `${r.toast}${resumed ? ` · ${resumed} resumed to fix` : ""}` });
          return;
        }
        case "repro/reject": {
          const owner = options.registry ? reproDraftFor(options.registry, id) : null;
          const testPath = str(body, "testPath", false) || owner?.draft.testPath || "";
          if (!testPath) throw new ActionError(400, "repro reject needs testPath — or a session that reported the repro test");
          const reason = str(body, "reason");
          const r = await rejectReproTest(store, id, { testPath, reason });
          let resumed: string | null = null;
          if (owner) {
            markReproRejected(owner, reason, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
            const s = await resumeAfterRepro(owner, `The engineer sent the repro test ${testPath} back — wrong failure: ${reason}. Rewrite the test so it fails for the right reason, run it, and call mcp__sdlc__report_repro again with the verbatim output. Do not fix the code yet.`, launchDeps(options, store, options.registry ?? null));
            resumed = s?.id ?? null;
            store.rebuild();
          }
          reply(res, { ...r, toast: `${r.toast}${resumed ? ` · ${resumed} resumed to rewrite it` : ""}` });
          return;
        }
        case "freeze/lift":
          reply(res, await liftTestFreeze(store, id, { path: str(body, "path"), reason: str(body, "reason") }));
          return;
        case "auto-findings/dismiss":
          reply(res, await dismissPrAutoFinding(store, id, { path: str(body, "path"), reason: str(body, "reason") }));
          return;
          return;
        default:
          throw new ActionError(404, `unknown action ${action}`);
      }
    }
    if (parts[1] === "evals") {
      if (method === "GET" && parts.length === 2) {
        json(res, 200, (await store.refresh()).evals);
        return;
      }
      if (method === "POST" && parts[2] === "run" && parts.length === 3) {
        if (!options.engine) throw new ActionError(409, "suite runs need the engine (start the server with sdlcBin)");
        const body = await readBody(req);
        const trigger = typeof body["trigger"] === "string" ? body["trigger"] : "manual";
        if (!["manual", "schedule", "config-pr"].includes(trigger)) throw new ActionError(400, "trigger must be manual, schedule or config-pr");
        const { job } = await options.engine.runSuite(trigger as "manual" | "schedule" | "config-pr", false);
        if (!job) throw new ActionError(502, "repository not loaded", [], true);
        json(res, 200, { ok: true, job, toast: job.state === "running" ? `suite run queued (${job.key.split(":").at(-1)}) — the strip updates when it commits` : `${job.key}: ${job.note ?? job.error ?? job.state}`, revision: store.current?.revision ?? 0 });
        return;
      }
      throw new ActionError(404, "not found");
    }
    if (parts[1] === "webhooks") {
      const env = options.env ?? process.env;
      if (method === "GET" && parts.length === 2) {
        const last = options.engine?.lastDeliveryAt ?? 0;
        json(res, 200, {
          path: "/api/webhooks/github",
          enabled: Boolean(env["GITHUB_WEBHOOK_SECRET"]) && Boolean(options.engine) && Boolean(options.deliveries),
          secretSet: Boolean(env["GITHUB_WEBHOOK_SECRET"]),
          engine: Boolean(options.engine),
          lastDeliveryAt: last > 0 ? new Date(last).toISOString() : null,
          lastPollAt: (options.engine?.lastSyncAt ?? 0) > 0 ? new Date(options.engine?.lastSyncAt ?? 0).toISOString() : null,
          pollIntervalMs: options.engine?.pollInterval() ?? null,
          deliveries: options.deliveries?.recent(20) ?? [],
        });
        return;
      }
      if (method === "POST" && parts[2] === "github" && parts.length === 3) {
        const body = await readRaw(req, 1024 * 1024);
        const r = await receiveWebhook({ store, engine: options.engine ?? null, deliveries: options.deliveries ?? null, env }, { headers: { event: header(req, "x-github-event"), delivery: header(req, "x-github-delivery"), signature: header(req, "x-hub-signature-256") }, body });
        json(res, r.status, r.body);
        return;
      }
      throw new ActionError(404, "not found");
    }
    if (parts[1] === "sync" && method === "POST") {
      if (!options.engine) throw new ActionError(409, "sync needs the engine (start the server with sdlcBin)");
      const summary = await options.engine.sync();
      if (!summary) throw new ActionError(409, "GitHub sync is off: config.codeHost is not github or GITHUB_TOKEN is not set");
      const toast = `sync: ${summary.opened.length} PR(s) opened · ${summary.merges.filter((m) => m.recorded).length} merge(s) recorded · records ${summary.records.pushed ? `PR #${summary.records.number ?? "?"} (${summary.records.ahead} ahead)` : summary.records.error ? `failed: ${summary.records.error}` : "in sync"}${summary.errors.length > 0 ? ` · ${summary.errors.length} error(s)` : ""}`;
      json(res, 200, { ok: true, sync: summary, toast, revision: store.current?.revision ?? 0 });
      return;
    }
    if (parts[1] === "sessions" && method === "GET" && parts[2] && parts[3] === "rounds" && parts[4] && parts[5] === "screenshot" && parts.length === 6) {
      // a round's screenshot as the session saved it (screenshotRef, relative to the worktree); nothing outside the worktree is served
      const registry = options.registry;
      const s = registry?.get(parts[2]);
      if (!s) throw new ActionError(404, `${parts[2]} not found`);
      const round = (readRounds(s.worktreePath, s.id) as { n: number; screenshotRef?: string }[]).find((r) => r.n === Number(parts[4]));
      if (!round?.screenshotRef) throw new ActionError(404, `round ${parts[4]} of ${s.id} has no screenshot`);
      const base = resolve(s.worktreePath);
      const abs = resolve(base, round.screenshotRef);
      if (!abs.startsWith(base + sep) || !existsSync(abs) || !statSync(abs).isFile()) throw new ActionError(404, `screenshot ${round.screenshotRef} is not in the worktree`);
      res.writeHead(200, { "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", "content-length": statSync(abs).size, "cache-control": "private, max-age=60" });
      createReadStream(abs).pipe(res);
      return;
    }
    if (parts[1] === "sessions" && method === "POST") {
      const registry = options.registry;
      if (!registry || !options.sdlcBin) throw new ActionError(409, "sessions are unavailable: the server was started without a session registry");
      const body = await readBody(req);
      const id = parts[2];
      if (!id) {
        const input: LaunchInput = { changeId: str(body, "changeId"), ...(typeof body["kind"] === "string" ? { kind: body["kind"] as LaunchInput["kind"] } : {}), ...(typeof body["taskId"] === "string" ? { taskId: body["taskId"] } : {}), ...(typeof body["target"] === "string" && body["target"].trim() !== "" ? { target: body["target"] } : {}), ...(typeof body["mode"] === "string" ? { mode: body["mode"] as LaunchInput["mode"] } : {}) };
        const r = await launchSession(input, { root: store.root, registry, sdlcBin: options.sdlcBin, identity: store.who, ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}), onExit: (s) => (options.engine ? void options.engine.onSessionExit(s) : store.rebuild()) });
        store.rebuild();
        json(res, 200, { ok: true, session: r.session, toast: r.session.mode === "SUPERVISED" ? `${r.session.id} prepared — run the command from the card` : `${r.session.id} started (${r.session.mode}) on ${r.session.branch}`, revision: store.current?.revision ?? 0 });
        return;
      }
      const action = parts[3];
      if (action === "stop" || action === "takeover") {
        const s = stopSession(registry, id, action === "stop" ? "stopped" : "taken_over");
        store.rebuild();
        json(res, 200, { ok: true, session: s, toast: action === "stop" ? `${id} stopped` : `${id} taken over — worktree ${s.worktreePath}`, revision: store.current?.revision ?? 0 });
        return;
      }
      if (action === "downgrade") {
        const r = await downgradeSession({ store, registry, ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}) }, id, str(body, "reason", false) || undefined);
        store.rebuild();
        json(res, 200, { ok: true, commit: r.commit, changeId: r.session.changeId, session: r.session, toast: `${id} downgraded to SUPERVISED — run the command from the card`, revision: store.current?.revision ?? 0 });
        return;
      }
      if (action === "raise-cap") {
        const s = registry.get(id);
        if (!s) throw new ActionError(404, `${id} not found`);
        if (s.capRaised) throw new ActionError(409, "the round cap can be raised once per session");
        registry.patch(id, { capRaised: true });
        store.rebuild();
        json(res, 200, { ok: true, toast: `round cap raised once for ${id}`, revision: store.current?.revision ?? 0 });
        return;
      }
      if (action === "message") {
        const s = registry.get(id);
        if (!s) throw new ActionError(404, `${id} not found`);
        if (s.status === "running") throw new ActionError(409, "the session is still running; guidance is delivered by resuming a finished or stalled session");
        const r = await launchSession({ changeId: s.changeId, kind: s.kind, ...(s.taskId ? { taskId: s.taskId } : {}), ...(s.target ? { target: s.target } : {}), mode: s.mode, resume: { sessionId: id, guidance: str(body, "text") } }, { root: store.root, registry, sdlcBin: options.sdlcBin, identity: store.who, ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}), onExit: (s) => (options.engine ? void options.engine.onSessionExit(s) : store.rebuild()) });
        store.rebuild();
        json(res, 200, { ok: true, session: r.session, toast: `guidance sent — ${id} resumed`, revision: store.current?.revision ?? 0 });
        return;
      }
      throw new ActionError(404, `unknown session action ${action ?? ""}`);
    }
    if (parts[1] === "proposals" && parts[2] && method === "POST") {
      const body = await readBody(req);
      if (parts[3] === "dismiss") return reply(res, await proposalDismiss(store, parts[2], str(body, "reason")));
      if (parts[3] === "accept") throw new ActionError(409, "accepting a proposal opens a PR on the code host (GitHub mode, Phase 2)");
    }
    if (parts[1] === "triage" && parts[2] && method === "POST") {
      const body = await readBody(req);
      if (parts[3] === "accept") return reply(res, await triageAccept(store, parts[2]));
      if (parts[3] === "dismiss") return reply(res, await triageDismiss(store, parts[2], str(body, "reason"), str(body, "bandTune", false) || undefined));
    }
    if (parts[1] === "findings" && parts[2] === "import" && method === "POST") {
      const body = await readBody(req);
      return reply(res, await findingsImport(store, str(body, "text")));
    }
    if (parts[1] === "findings" && parts[2] && method === "POST") {
      const body = await readBody(req);
      if (parts[3] === "patch") return reply(res, await findingPatch(store, parts[2]));
      if (parts[3] === "escalate") return reply(res, await findingEscalate(store, parts[2]));
      if (parts[3] === "dismiss") return reply(res, await findingDismiss(store, parts[2], str(body, "reason")));
    }
    throw new ActionError(404, "not found");
  }

  function reply(res: ServerResponse, r: ActionResult): void {
    json(res, 200, { ok: true, commit: r.commit, changeId: r.changeId, toast: r.toast, revision: r.snapshot.revision });
  }

  return {
    server,
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribe();
        for (const ws of clients) ws.close();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { readFile, type Tree } from "@sdlc/core";
import { parseFrontMatter, type GateNumber } from "@sdlc/schemas";
import { WebSocketServer, type WebSocket } from "ws";
import {
  acceptGate,
  confirmReproTest,
  confirmTaskSplit,
  findingDismiss,
  findingEscalate,
  findingPatch,
  findingsImport,
  loopChange,
  newChange,
  sendBackGate,
  triageAccept,
  triageDismiss,
  type ActionResult,
} from "./actions.js";
import type { Engine, JobStore } from "./engine/index.js";
import { launchSession, stopSession, type LaunchInput, type SessionRegistry } from "./sessions/index.js";
import { ActionError, type StateStore } from "./store.js";

type Body = Record<string, unknown>;

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
          reply(res, await acceptGate(store, id, gateOf(body)));
          return;
        case "send-back":
          reply(res, await sendBackGate(store, id, gateOf(body), str(body, "feedback")));
          return;
        case "loop":
          reply(res, await loopChange(store, id));
          return;
        case "tasks/confirm":
          reply(res, await confirmTaskSplit(store, id, Array.isArray(body["tasks"]) ? (body["tasks"] as never) : undefined));
          return;
        case "repro/confirm":
          reply(res, await confirmReproTest(store, id, { testPath: str(body, "testPath"), failureReason: str(body, "failureReason"), sha: str(body, "sha"), output: str(body, "output", false) }));
          return;
        default:
          throw new ActionError(404, `unknown action ${action}`);
      }
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

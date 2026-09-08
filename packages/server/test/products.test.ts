import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { commitWritePlan, git, initRepo } from "@sdlc/adapter-git";
import { accept, deriveChange, loadRepo } from "@sdlc/core";
import { hookContext } from "@sdlc/hooks";
import { PO, writeMonorepoSeed, writeSeed } from "@sdlc/fixtures";
import { readTree } from "@sdlc/adapter-git";
import WebSocket from "ws";
import { Engine, JobStore, SessionRegistry, SnapshotCache, StateStore, launchSession, openCache, resolveProducts, startServer, type Exec, type Snapshot } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const PRIYA = { id: PO, name: "Priya Owens" };
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

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function repo(prefix: string, seed: (dir: string) => void): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmRetry(dir));
  await initRepo(dir, "main", PRIYA);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  seed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

const monorepo = () => repo("sdlc-mono-", (dir) => writeMonorepoSeed(dir));

async function post(url: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const state = async (url: string, product?: string, headers: Record<string, string> = {}) => (await (await fetch(`${url}/api/state${product ? `?product=${product}` : ""}`, { headers })).json()) as Snapshot;

describe("multi-product server (3.2): one store per product, addressed explicitly", () => {
  it("lists the products of a monorepo, serves each product's own tree, and shards the cache per home", async () => {
    const dir = await monorepo();
    const server = await startServer({ cwd: dir, identity: PRIYA, watch: false });
    cleanups.push(() => server.close());
    const listed = (await (await fetch(`${server.url}/api/products`)).json()) as { current: string; products: { name: string; home: string; prefix: string; primary: boolean }[] };
    expect(listed.current).toBe("invoicing");
    expect(listed.products).toEqual([
      expect.objectContaining({ name: "invoicing", home: dir, prefix: "", primary: true }),
      expect.objectContaining({ name: "billing", home: join(dir, "apps/billing"), prefix: "apps/billing/", primary: false }),
    ]);
    expect(server.products.map((p) => p.name)).toEqual(["invoicing", "billing"]);
    // both by query string and by header; an unknown product is a 404 naming the ones served
    expect((await state(server.url, "billing")).changes).toHaveLength(8);
    expect((await state(server.url, undefined, { "x-sdlc-product": "billing" })).changes).toHaveLength(8);
    const unknown = await fetch(`${server.url}/api/state?product=nope`);
    expect(unknown.status).toBe(404);
    expect(String(((await unknown.json()) as { error: string }).error)).toContain("serving invoicing, billing");
    // each product has its own disposable cache under its own home
    expect(existsSync(join(dir, ".sdlc-state/sessions.db"))).toBe(true);
    expect(existsSync(join(dir, "apps/billing/.sdlc-state/sessions.db"))).toBe(true);
  });

  it("an action addressed to a product commits under that product's home and moves only that product's view; sockets follow their product", async () => {
    const dir = await monorepo();
    const server = await startServer({ cwd: dir, identity: PRIYA, watch: false });
    cleanups.push(() => server.close());
    const billing = new WebSocket(`${server.url.replace("http", "ws")}/api/events?product=billing`);
    cleanups.push(() => billing.close());
    const first = await new Promise<{ product: string; snapshot: Snapshot }>((resolve) => billing.once("message", (d) => resolve(JSON.parse(String(d)) as { product: string; snapshot: Snapshot })));
    expect(first.product).toBe("billing");
    expect(first.snapshot.revision).toBe(1);
    const next = new Promise<{ product: string; snapshot: Snapshot }>((resolve) => billing.once("message", (d) => resolve(JSON.parse(String(d)) as { product: string; snapshot: Snapshot })));
    const r = await post(`${server.url}/api/changes/CHG-0022/accept?product=billing`, { gate: 1 });
    expect(r.status).toBe(200);
    expect(r.body["toast"]).toBe("Accept intent.md — CHG-0022 moved to Design");
    const pushed = await next;
    expect(pushed.product).toBe("billing");
    expect(pushed.snapshot.changes.find((c) => c.id === "CHG-0022")?.stage).toBe(2);
    // the commit touched the product's files only
    const touched = (await git(dir, ["show", "--stat", "--format=", String(r.body["commit"])])).trim();
    expect(touched).toContain("apps/billing/sdlc/changes/CHG-0022/");
    expect(touched).not.toMatch(/^ sdlc\//m);
    // the root product's CHG-0022 is untouched (the products share one HEAD, so the root re-derives, to the same view)
    const root = await state(server.url);
    expect(root.changes.find((c) => c.id === "CHG-0022")?.stage).toBe(1);
    expect(root.queues).toEqual(first.snapshot.queues);
    expect((await state(server.url, "billing")).revision).toBe(2);
    // a socket for an unknown product is refused
    const bad = new WebSocket(`${server.url.replace("http", "ws")}/api/events?product=nope`);
    await new Promise<void>((resolve) => {
      bad.once("error", () => resolve());
      bad.once("close", () => resolve());
    });
  }, 20_000);

  it("--repo serves further repositories; product names must be unique across them; a repository without config.products is one product named after its directory", async () => {
    const dir = await monorepo();
    const other = await repo("sdlc-other-", (d) => writeSeed(d));
    await expect(startServer({ cwd: dir, repos: [other], identity: PRIYA, watch: false })).rejects.toThrow(/two products are named invoicing/);
    const cfg = join(other, "sdlc/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("  - name: invoicing\n    path: .\n", "  - name: website\n    path: .\n"));
    await git(other, ["commit", "-q", "-am", "rename"]);
    const server = await startServer({ cwd: dir, repos: [other], identity: PRIYA, watch: false });
    cleanups.push(() => server.close());
    expect(server.products.map((p) => [p.name, p.root])).toEqual([
      ["invoicing", dir],
      ["billing", dir],
      ["website", other],
    ]);
    expect((await state(server.url, "website")).changes).toHaveLength(8);

    const bare = await repo("sdlc-bare-", (d) => {
      writeSeed(d);
      const c = join(d, "sdlc/config.yaml");
      writeFileSync(c, readFileSync(c, "utf8").replace("products:\n  - name: invoicing\n    path: .\n", ""));
    });
    const specs = await resolveProducts(bare);
    expect(specs).toEqual([{ name: bare.split("/").at(-1), root: bare, home: bare, prefix: "" }]);
  }, 20_000);

  it("a session for a nested product works in the product's home inside the worktree, and its MCP server and hooks resolve that home", async () => {
    const dir = await monorepo();
    const home = join(dir, "apps/billing");
    const registry = new SessionRegistry(home);
    cleanups.push(() => registry.close());
    const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: home, registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
    const checkout = join(home, ".sdlc-state/worktrees/CHG-0018__export-fix");
    expect(launched.session.worktreePath).toBe(join(checkout, "apps/billing"));
    expect(existsSync(join(checkout, "apps/billing/sdlc/config.yaml"))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(launched.session.worktreePath, ".sdlc-state/sessions", launched.session.id, "mcp.json"), "utf8")) as { mcpServers: { sdlc: { env: Record<string, string> } } };
    expect(mcp.mcpServers.sdlc.env["SDLC_HOME"]).toBe("apps/billing");
    expect(launched.session.command).toContain(`cd ${join(checkout, "apps/billing")} &&`);
    // the session.started line went to the product's ledger on the task branch
    const touched = (await git(checkout, ["show", "--stat", "--format=", "HEAD"])).trim();
    expect(touched).toContain("apps/billing/sdlc/changes/CHG-0018/log.jsonl");
    // hooks (and the MCP server, same resolution) find the product's home from the session's cwd + SDLC_HOME
    const ctx = await hookContext({ session_id: "x", cwd: launched.session.worktreePath, hook_event_name: "PreToolUse" }, { SDLC_HOME: "apps/billing", SDLC_CHANGE: "CHG-0018" });
    expect(ctx?.root).toBe(join(checkout, "apps/billing"));
    expect(ctx?.view.id).toBe("CHG-0018");
    expect(ctx?.repo.changes.size).toBe(8);
  });
});

describe("shared, disposable cache (3.2)", () => {
  it("two processes on the same cache cannot both claim a job key: the primary key arbitrates inside SQLite", async () => {
    const dir = await repo("sdlc-claim-", (d) => writeSeed(d));
    const a = openCache(join(dir, ".sdlc-state/sessions.db"));
    const b = openCache(join(dir, ".sdlc-state/sessions.db"));
    cleanups.push(() => {
      a.close();
      b.close();
    });
    const jobsA = new JobStore(a);
    const jobsB = new JobStore(b);
    const key = "CHG-0018:1:4:abc:build:run-0";
    const wins = [jobsA.claim({ key, kind: "build-session", changeId: "CHG-0018", cycle: 1, stage: 4 }, "2026-09-08T09:00:00Z"), jobsB.claim({ key, kind: "build-session", changeId: "CHG-0018", cycle: 1, stage: 4 }, "2026-09-08T09:00:01Z")];
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(jobsB.get(key)?.createdAt).toBe("2026-09-08T09:00:00Z");
    // a second operator's process sees the first one's queue
    expect(jobsB.list().map((j) => j.key)).toEqual([key]);
  });

  it("a restart warm-starts from the cached derivation; deleting .sdlc-state loses no lifecycle fact — the view and the queue come back from git", async () => {
    const dir = await repo("sdlc-cache-", (d) => writeSeed(d));
    const exec: Exec = () => Promise.resolve({ exitCode: 0, output: "ok" });
    const harness = (autoLaunch: boolean) => {
      const registry = new SessionRegistry(dir);
      const cache = new SnapshotCache(registry.database);
      const store = new StateStore({ root: dir, identity: ENG, cache, sessions: () => registry.list() });
      const jobs = new JobStore(registry.database);
      const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec, autoLaunch, now: () => new Date("2026-09-08T09:00:00Z") });
      return { registry, cache, store, jobs, engine, close: () => { engine.close(); registry.close(); } };
    };
    // gate 1 accepted on CHG-0022 → the engine owes a design pass, keyed on the intent's sha in git
    const tree = loadRepo(await readTree(dir, "HEAD"));
    const files = tree.changes.get("CHG-0022");
    if (!files) throw new Error("seed");
    const r = accept(tree, deriveChange(tree, files), 1, { now: "2026-09-08T09:00:00Z", newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9TC", actor: { id: PO } });
    if (!r.ok) throw new Error("accept");
    await commitWritePlan(dir, r.plan, { identity: PRIYA });

    const a = harness(true);
    await a.store.refresh();
    await a.engine.tick();
    await waitFor(() => a.jobs.list().some((j) => j.kind === "design-pass" && j.state !== "running"));
    await waitFor(() => a.jobs.list().every((j) => j.state !== "running") && a.registry.list().every((s) => s.status !== "running"));
    await new Promise((res) => setTimeout(res, 500));
    const snapA = await a.store.refresh(true);
    const design = a.jobs.list().find((j) => j.kind === "design-pass");
    expect(design?.changeId).toBe("CHG-0022");
    expect(design?.state).toBe("done");
    const keysA = a.jobs.list().map((j) => j.key).sort();
    const view = (s: Snapshot) => ({ changes: s.changes.map((c) => [c.id, c.stage, c.status]), queues: s.queues, badges: s.badges, branches: s.branches?.map((b) => b.branch) });
    expect(a.cache.keys()).toHaveLength(1);
    expect(snapA.revision).toBeGreaterThan(1);
    a.close();

    // another process (a restart, a second operator's server) on the same cache serves the last derivation as is
    const b = harness(false);
    const snapB = await b.store.refresh();
    expect(snapB.revision).toBe(snapA.revision);
    expect(view(snapB)).toEqual(view(snapA));
    expect(b.jobs.list().map((j) => j.key).sort()).toEqual(keysA);
    b.close();

    // the cache is disposable: without it the same view derives from git, the queue is empty, and the engine re-derives
    // the work whose result is not in git — the design pass under the same key (its session left no spec behind)
    await rmRetry(join(dir, ".sdlc-state"));
    const c = harness(true);
    expect(c.jobs.list()).toEqual([]);
    expect(c.cache.keys()).toEqual([]);
    const snapC = await c.store.refresh();
    expect(snapC.revision).toBe(1);
    expect(view(snapC)).toEqual(view(snapA));
    await c.engine.tick();
    await waitFor(() => c.jobs.list().some((j) => j.kind === "design-pass" && j.state !== "running"));
    expect(c.jobs.list().find((j) => j.kind === "design-pass")?.key).toBe(design?.key);
    await waitFor(() => c.registry.list().every((s) => s.status !== "running"));
    c.close();
    cleanups.push(() => new Promise((res) => setTimeout(res, 300)));
  }, 60_000);
});

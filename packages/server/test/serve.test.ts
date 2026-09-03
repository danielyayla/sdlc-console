import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { PO, seedSessions, writeSeed } from "@sdlc/fixtures";
import WebSocket from "ws";
import { startServer, type RunningServer, type Snapshot } from "../src/index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seededServer(): Promise<{ dir: string; server: RunningServer }> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-serve-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const server = await startServer({ cwd: dir, identity: { id: PO, name: "Priya Owens" }, sessions: () => seedSessions() as never, watch: true });
  cleanups.push(() => server.close());
  return { dir, server };
}

async function post(url: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

function nextMessage(ws: WebSocket): Promise<{ type: string; snapshot: Snapshot }> {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)) as { type: string; snapshot: Snapshot })));
}

describe("sdlc serve", () => {
  it("serves the derived snapshot with identity, defaultRole, queues, badges and sessions", async () => {
    const { server } = await seededServer();
    const snap = (await (await fetch(`${server.url}/api/state`)).json()) as Snapshot;
    expect(snap.revision).toBe(1);
    expect(snap.identity).toEqual({ id: PO, name: "Priya Owens", roles: ["po"] });
    expect(snap.defaultRole).toBe("po");
    expect(snap.changes).toHaveLength(8);
    expect(snap.queues.po.yours).toEqual(["CHG-0022", "CHG-0012", "CHG-0021"]);
    expect(snap.badges).toEqual({ po: { gates: 3, loop: 2, security: 2 }, eng: { gates: 2, loop: 2, security: 2 } });
    expect(snap.sessions).toHaveLength(4);
    expect(snap.hooks.filter((h) => h.source === "hooks")).toHaveLength(3);
    expect(snap.metrics.map((m) => m.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(snap.validation.blocking).toBe(false);
    const one = (await (await fetch(`${server.url}/api/changes/CHG-0020`)).json()) as { autoEligible: { value: boolean } };
    expect(one.autoEligible.value).toBe(true);
    const art = (await (await fetch(`${server.url}/api/changes/CHG-0022/artifacts/0`)).json()) as { present: boolean; body: string; frontMatter: { artifact: string } };
    expect(art.present).toBe(true);
    expect(art.body).toContain("# Intent: Multi-currency invoice totals");
    expect(art.frontMatter.artifact).toBe("intent");
    const absent = (await (await fetch(`${server.url}/api/changes/CHG-0022/artifacts/1`)).json()) as { present: boolean };
    expect(absent.present).toBe(false);
  });

  it("pushes a snapshot on connect and a new revision after an action and after an external commit", async () => {
    const { dir, server } = await seededServer();
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    cleanups.push(() => ws.close());
    const first = await nextMessage(ws);
    expect(first.type).toBe("snapshot");
    expect(first.snapshot.revision).toBe(1);

    const pending = nextMessage(ws);
    const r = await post(`${server.url}/api/changes/CHG-0022/accept`, { gate: 1 });
    expect(r.status).toBe(200);
    expect(r.body["toast"]).toBe("Accept intent.md — CHG-0022 moved to Design");
    const second = await pending;
    expect(second.snapshot.revision).toBe(2);
    expect(second.snapshot.changes.find((c) => c.id === "CHG-0022")?.stage).toBe(2);
    expect(second.snapshot.badges.po.gates).toBe(2);

    // external commit (someone edits with an editor and commits): the watcher picks it up
    const pending2 = nextMessage(ws);
    const p = join(dir, "sdlc/changes/CHG-0023/intent.md");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "---\nid: CHG-0023\nartifact: intent\ncycle: 1\nauthor: po@veri.example\ncreated: 2026-09-03T10:00:00Z\nschema: 1\n---\n# Intent: Dunning reminders schedule\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Affected users and systems\na\n\n## Constraints\nc\n\n## Open questions\nq\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "intent by hand"]);
    const third = await Promise.race([pending2, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watcher did not fire")), 5000))]);
    expect(third.snapshot.revision).toBe(3);
    expect(third.snapshot.changes.find((c) => c.id === "CHG-0023")?.gate?.s).toBe(1);
  }, 15_000);

  it("answers 403 for the wrong role, 409 for a closed gate, 404 for unknown ids, 400 for bad input", async () => {
    const { server } = await seededServer();
    const eng = await post(`${server.url}/api/changes/CHG-0020/accept`, { gate: 3 }); // po identity does not hold eng
    expect(eng.status).toBe(403);
    expect(String(eng.body["error"])).toContain("does not hold the engineer role");
    const closed = await post(`${server.url}/api/changes/CHG-0023/accept`, { gate: 1 });
    expect(closed.status).toBe(409);
    expect(Array.isArray(closed.body["diagnostics"])).toBe(true);
    expect((await post(`${server.url}/api/changes/CHG-9999/accept`, { gate: 1 })).status).toBe(404);
    expect((await post(`${server.url}/api/changes/CHG-0022/accept`, { gate: 4 })).status).toBe(400);
    expect((await post(`${server.url}/api/changes/CHG-0021/send-back`, { gate: 2 })).status).toBe(400);
    expect((await fetch(`${server.url}/api/nope`)).status).toBe(404);
  });

  it("routes triage, findings, send-back, loop and change creation through the same path", async () => {
    const { server } = await seededServer();
    const sb = await post(`${server.url}/api/changes/CHG-0021/send-back`, { gate: 2, feedback: "resolve C1 first" });
    expect(sb.status).toBe(200);
    expect(sb.body["toast"]).toBe("spec.md sent back — CHG-0021 stays in Design");

    const tri = await post(`${server.url}/api/triage/TRI-0042/accept`);
    expect(tri.status).toBe(200);
    expect(tri.body["toast"]).toBe("CHG-0024 created — waiting at the Plan gate");
    const dismiss = await post(`${server.url}/api/triage/TRI-0043/dismiss`, { reason: "duplicate of CHG-0018", bandTune: "n/a" });
    expect(dismiss.status).toBe(200);

    const esc = await post(`${server.url}/api/findings/SEC-0118/escalate`);
    expect(esc.status).toBe(403); // po identity cannot route findings
    expect((await post(`${server.url}/api/findings/import`, { text: "scannerId,sev,title\nx,high,T" })).status).toBe(403);
    expect((await post(`${server.url}/api/findings/import`, { text: "" })).status).toBe(400);
    const created = await post(`${server.url}/api/changes`, { title: "Dunning reminders", kind: "feature", risk: "routine", origin: "idea" });
    expect(created.status).toBe(200);
    expect(created.body["changeId"]).toBe("CHG-0025");

    expect((await post(`${server.url}/api/proposals/PRP-0007/accept`)).status).toBe(409);
    expect((await post(`${server.url}/api/proposals/PRP-0007/dismiss`, { reason: "covered by lint" })).status).toBe(403); // po identity
    const loop = await post(`${server.url}/api/changes/CHG-0012/loop`);
    expect(loop.status).toBe(200);
    expect(loop.body["toast"]).toBe("Loop closed — CHG-0012 re-entered Plan");
    const snap = (await (await fetch(`${server.url}/api/state`)).json()) as Snapshot;
    expect(snap.changes.find((c) => c.id === "CHG-0012")).toMatchObject({ cycle: 2, stage: 1 });
    expect(snap.badges.po.loop).toBe(0);
    expect(snap.validation.blocking).toBe(false);
  }, 15_000);
});

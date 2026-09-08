import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitTrailers, git, initRepo } from "@sdlc/adapter-git";
import { ENG, PO, intakePayload, writeSeed } from "@sdlc/fixtures";
import { DeliveryLog, SessionRegistry, StateStore, createApp, receiveIntake } from "../src/index.js";

const SEC_SECRET = "cs-s3cret";
const TAG_SECRET = "ct-s3cret";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-intake-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

function harness(dir: string, env: Record<string, string | undefined>) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: { id: ENG, name: "Eli Ng" }, sessions: () => registry.list() });
  const deliveries = new DeliveryLog(registry.database);
  const now = () => new Date("2026-09-08T09:00:00Z");
  const sign = (secret: string, body: string | Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const deliver = (kind: "claude-security" | "claude-tag", payload: unknown, secret = kind === "claude-security" ? SEC_SECRET : TAG_SECRET, raw?: string) => {
    const body = Buffer.from(raw ?? JSON.stringify(payload));
    return receiveIntake(kind, { store, deliveries, env, now }, { headers: { signature: sign(secret, body) }, body });
  };
  return { registry, store, deliveries, deliver, sign, now };
}

const commits = async (dir: string) => (await git(dir, ["rev-list", "--count", "HEAD"])).trim();

describe("Claude Security intake (3.5): signature, envelope, replay, then a finding file committed by sdlc-bot", () => {
  it("503 without the secret, 401 on a bad signature, 400 on a foreign envelope, then commits the findings and answers the redelivery with a no-op", async () => {
    const dir = await seedRepo();
    const env = { SDLC_CLAUDE_SECURITY_WEBHOOK_SECRET: SEC_SECRET, SDLC_CLAUDE_TAG_WEBHOOK_SECRET: TAG_SECRET };
    const h = harness(dir, env);
    await h.store.refresh();
    const payload = intakePayload("claude-security");
    const off = await receiveIntake("claude-security", { store: h.store, deliveries: h.deliveries, env: {} }, { headers: { signature: undefined }, body: Buffer.from(JSON.stringify(payload)) });
    expect(off.status).toBe(503);
    expect(String(off.body["error"])).toContain("SDLC_CLAUDE_SECURITY_WEBHOOK_SECRET");
    expect((await h.deliver("claude-security", payload, "wrong")).status).toBe(401);
    expect((await h.deliver("claude-security", payload, TAG_SECRET)).status).toBe(401); // the other receiver's secret does not sign this one
    const foreign = await h.deliver("claude-security", { ...payload, source: "snyk" });
    expect(foreign.status).toBe(400);
    expect(Array.isArray(foreign.body["diagnostics"])).toBe(true);
    expect((await h.deliver("claude-security", null, SEC_SECRET, "{not json")).status).toBe(400);
    expect(await commits(dir)).toBe("1");
    expect(h.deliveries.recent()).toEqual([]); // refusals before the transform are not deliveries

    const ok = await h.deliver("claude-security", payload);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, replay: false, delivery: { id: "claude-security:cs-delivery-0001", event: "claude-security", action: "run scan-2026-09-08-01", status: 200, changeId: null }, ingest: { created: ["SEC-0121"], updated: ["SEC-0118"] } });
    expect(await commits(dir)).toBe("2");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    expect(await commitTrailers(dir, head)).toEqual({ "SDLC-Actor": "system:sdlc-bot", "SDLC-Delivery": "claude-security:cs-delivery-0001", "SDLC-Scan": "scan-2026-09-08-01" });
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>"])).trim()).toBe("sdlc-bot <sdlc-bot@sdlc.local>");
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe("sdlc(security): claude-security run scan-2026-09-08-01 — 1 new, 1 updated");
    const file = readFileSync(join(dir, "sdlc/security/findings/SEC-0121.yaml"), "utf8");
    expect(file).toContain("scannerId: claude-security:a41c07");
    expect(file).toContain("source: claude-security");
    expect(file).toContain("evidence: |-\n  src/webhooks/verify.ts:18\n    if (given == expected) return true;");
    // the view: the finding is in the snapshot with source, confidence and run
    const snap = h.store.current;
    expect(snap?.findings.find((f) => f.id === "SEC-0121")).toMatchObject({ source: "claude-security", conf: 0.88, run: { id: "scan-2026-09-08-01", url: "https://security.example/runs/scan-2026-09-08-01" }, status: "new" });

    // the same delivery id again: 200, replay, no commit
    const replay = await h.deliver("claude-security", payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, replay: true, delivery: { id: "claude-security:cs-delivery-0001" } });
    expect(await commits(dir)).toBe("2");
    // a new delivery id with nothing new: 200, recorded as a no-op, no commit
    const same = await h.deliver("claude-security", { ...payload, deliveryId: "cs-delivery-0001b" });
    expect(same.status).toBe(200);
    expect(String((same.body["delivery"] as { outcome: string }).outcome)).toContain("no-op");
    expect(await commits(dir)).toBe("2");
    // the update and the resolution land as further commits; the routing status is the console's
    const patched = await h.store.act((repo, ctx) => ({ ok: true, plan: { changeId: null, files: [{ path: "sdlc/security/findings/SEC-0121.yaml", content: readFileSync(join(dir, "sdlc/security/findings/SEC-0121.yaml"), "utf8").replace("status: new", "status: patch_pr") }], events: [], commitMessage: "sdlc(SEC-0121): patch in PR gate", trailers: { "SDLC-Actor": `human:${ctx.actor.id}` }, actor: { type: "human", id: ctx.actor.id } } }));
    expect(patched.commit).toBeTruthy();
    const resolvedR = await h.deliver("claude-security", intakePayload("claude-security-resolved"));
    expect(resolvedR.status).toBe(200);
    expect(resolvedR.body).toMatchObject({ ingest: { resolved: ["SEC-0121"], unknownResolved: ["000000"] } });
    const after = h.store.current?.findings.find((f) => f.id === "SEC-0121");
    expect(after).toMatchObject({ status: "patch_pr", resolved: { at: "2026-09-10T06:02:55Z", run: "scan-2026-09-10-01" } });
    expect(existsSync(join(dir, "sdlc/security/findings/SEC-0121.yaml"))).toBe(true);
    expect(h.deliveries.recent().map((d) => d.id)).toEqual(["claude-security:cs-delivery-0003", "claude-security:cs-delivery-0001b", "claude-security:cs-delivery-0001"]);
  });

  it("over HTTP: the open routes verify the raw body, GET /api/webhooks reports both receivers, and a bad signature never touches git", async () => {
    const dir = await seedRepo();
    const env = { SDLC_CLAUDE_SECURITY_WEBHOOK_SECRET: SEC_SECRET };
    const h = harness(dir, env);
    await h.store.refresh();
    const app = createApp(h.store, { registry: h.registry, deliveries: h.deliveries, env, now: h.now });
    cleanups.push(() => app.close());
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const body = JSON.stringify(intakePayload("claude-security"));
    const sig = h.sign(SEC_SECRET, body);
    const bad = await fetch(`${url}/api/webhooks/claude-security`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: `${body} ` });
    expect(bad.status).toBe(401);
    const unsigned = await fetch(`${url}/api/webhooks/claude-security`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(unsigned.status).toBe(401);
    expect(await commits(dir)).toBe("1");
    const ok = await fetch(`${url}/api/webhooks/claude-security`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, replay: false, ingest: { created: ["SEC-0121"] } });
    expect(await commits(dir)).toBe("2");
    const tagOff = await fetch(`${url}/api/webhooks/claude-tag`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: JSON.stringify(intakePayload("claude-tag")) });
    expect(tagOff.status).toBe(503);
    const status = (await (await fetch(`${url}/api/webhooks`)).json()) as { intake: Record<string, { path: string; enabled: boolean; secretSet: boolean; secretVar: string }>; deliveries: { id: string }[] };
    expect(status.intake).toEqual({
      "claude-security": { path: "/api/webhooks/claude-security", secretVar: "SDLC_CLAUDE_SECURITY_WEBHOOK_SECRET", secretSet: true, enabled: true },
      "claude-tag": { path: "/api/webhooks/claude-tag", secretVar: "SDLC_CLAUDE_TAG_WEBHOOK_SECRET", secretSet: false, enabled: false },
    });
    expect(status.deliveries.map((d) => d.id)).toEqual(["claude-security:cs-delivery-0001"]);
    const state = (await (await fetch(`${url}/api/state`)).json()) as { findings: { id: string; source?: string }[] };
    expect(state.findings.find((f) => f.id === "SEC-0121")?.source).toBe("claude-security");
  });
});

describe("Claude Tag intake (3.5): one channel item per message, committed by sdlc-bot, accepted through the Loop's own path", () => {
  it("creates TRI-0044 with the message verbatim, dedupes a second delivery of the same message, and the accept action turns it into a change", async () => {
    const dir = await seedRepo();
    const env = { SDLC_CLAUDE_TAG_WEBHOOK_SECRET: TAG_SECRET };
    const h = harness(dir, env);
    await h.store.refresh();
    const payload = intakePayload("claude-tag");
    expect((await h.deliver("claude-tag", payload, "nope")).status).toBe(401);
    const ok = await h.deliver("claude-tag", payload);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, replay: false, id: "TRI-0044", delivery: { id: "claude-tag:ct-delivery-0001", action: "message 1757318400.000100" } });
    expect(await commits(dir)).toBe("2");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    expect(await commitTrailers(dir, head)).toEqual({ "SDLC-Actor": "system:sdlc-bot", "SDLC-Delivery": "claude-tag:ct-delivery-0001", "SDLC-Message": "1757318400.000100" });
    const file = readFileSync(join(dir, "sdlc/loop/triage/TRI-0044.md"), "utf8");
    expect(file).toContain("tier: channel\nsrc: channel:slack:#support");
    expect(file).toMatch(/messageId: ["']?1757318400\.000100["']?\n/);
    expect(file).toContain("Customers on the annual plan see last month's invoice PDF");
    const item = h.store.current?.triage.find((t) => t.data.id === "TRI-0044");
    expect(item?.data.channel?.permalink).toBe("https://veri.slack.com/archives/C0SUPPORT1/p1757318400000100");
    // the same message under a fresh delivery id: recorded, nothing written
    const dup = await h.deliver("claude-tag", { ...payload, deliveryId: "ct-delivery-0002" });
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ ok: true, replay: false, duplicateOf: "TRI-0044" });
    expect(String((dup.body["delivery"] as { outcome: string }).outcome)).toContain("already TRI-0044");
    expect(await commits(dir)).toBe("2");
    // the replayed delivery id: the prior record
    expect((await h.deliver("claude-tag", payload)).body).toMatchObject({ replay: true });
    // Accept → Plan through the store, as the Loop view does; the PO owns it
    const po = h.store.as({ id: PO, name: "Priya Owens" });
    const { acceptTriage } = await import("@sdlc/core");
    const accepted = await po.act((repo, ctx) => acceptTriage(repo, "TRI-0044", ctx));
    expect(accepted.snapshot.triage.some((t) => t.data.id === "TRI-0044")).toBe(false);
    const change = accepted.snapshot.changes.find((c) => c.origin?.ref === "TRI-0044");
    expect(change?.origin).toEqual({ type: "triage", ref: "TRI-0044" });
    expect(change?.stage).toBe(1);
  });
});

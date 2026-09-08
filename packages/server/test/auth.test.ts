import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { ENG, PO, writeSeed } from "@sdlc/fixtures";
import WebSocket from "ws";
import { startServer, type RunningServer, type Snapshot } from "../src/index.js";
import { startFakeOidc, type FakeOidc } from "./fake-oidc.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Seed repo in hosted mode: `auth` in config points at the fake provider; the server's own identity is the PO's git identity. */
async function hostedServer(extra = ""): Promise<{ dir: string; server: RunningServer; oidc: FakeOidc }> {
  const oidc = await startFakeOidc();
  cleanups.push(() => oidc.close());
  const dir = mkdtempSync(join(tmpdir(), "sdlc-auth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: "console@veri.example", name: "Console" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, `${readFileSync(cfg, "utf8")}auth:\n  provider: oidc\n  issuer: ${oidc.url}\n  clientId: ${oidc.clientId}\n${extra}`);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed (hosted)"]);
  const server = await startServer({ cwd: dir, identity: { id: "console@veri.example", name: "Console" }, watch: false, env: {} });
  cleanups.push(() => server.close());
  return { dir, server, oidc };
}

const noRedirect = { redirect: "manual" as const };

/** Walk the browser's path: /auth/login → provider → /auth/callback; returns the session cookie. */
async function signIn(server: RunningServer, user: string | null): Promise<{ cookie: string | null; final: Response }> {
  const login = await fetch(`${server.url}/auth/login?return_to=/%3Fview%3Dgates`, noRedirect);
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get("location") ?? "");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${server.url}/auth/callback`);
  if (user) authorize.searchParams.set("user", user);
  const back = await fetch(authorize.toString(), noRedirect);
  expect(back.status).toBe(302);
  const callback = back.headers.get("location") ?? "";
  expect(callback.startsWith(`${server.url}/auth/callback?`)).toBe(true);
  const final = await fetch(callback, noRedirect);
  const set = final.headers.get("set-cookie");
  const m = set ? /sdlc_session=([^;]+)/.exec(set) : null;
  return { cookie: m && m[1] !== "" ? `sdlc_session=${m[1]}` : null, final };
}

async function state(server: RunningServer, cookie: string | null): Promise<{ status: number; body: Snapshot & { error?: string; login?: string } }> {
  const r = await fetch(`${server.url}/api/state`, { headers: cookie ? { cookie } : {} });
  return { status: r.status, body: (await r.json()) as Snapshot & { error?: string; login?: string } };
}

describe("hosted identity (3.1): OIDC login on sdlc serve", () => {
  it("without a session the API answers 401 with the login path, the socket closes with 4401, health and the SPA stay open", async () => {
    const { server } = await hostedServer();
    expect(server.auth?.provider.issuer).toBe(server.auth?.provider.issuer);
    const s = await state(server, null);
    expect(s.status).toBe(401);
    expect(s.body).toMatchObject({ error: expect.stringContaining("sign in"), login: "/auth/login", signedIn: false });
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(4401);
  });

  it("signs in through the provider with PKCE, maps the email claim to the config identity, and the snapshot carries that identity and its roles", async () => {
    const { server, oidc } = await hostedServer();
    const { cookie, final } = await signIn(server, PO);
    expect(final.status).toBe(303);
    expect(final.headers.get("location")).toBe("/?view=gates");
    expect(cookie).not.toBeNull();
    expect(final.headers.get("set-cookie")).toContain("HttpOnly");
    expect(final.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(oidc.requests.map((r) => r.path)).toEqual(["/.well-known/openid-configuration", "/authorize", "/token", "/jwks"]);
    const s = await state(server, cookie);
    expect(s.status).toBe(200);
    expect(s.body.identity).toEqual({ id: PO, name: "Priya Owens", roles: ["po"] });
    expect(s.body.config.auth).toMatchObject({ provider: "oidc", issuer: oidc.url, claim: "email", sessionHours: 12 });
    const me = (await (await fetch(`${server.url}/api/me`, { headers: { cookie: cookie ?? "" } })).json()) as { identity: { id: string }; auth: { provider: string; logout: string } };
    expect(me).toMatchObject({ identity: { id: PO }, auth: { provider: "oidc", logout: "/auth/logout" } });
    // the socket carries the viewer's identity too
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { cookie: cookie ?? "" } });
    const msg = await new Promise<{ snapshot: Snapshot }>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)) as { snapshot: Snapshot })));
    expect(msg.snapshot.identity.id).toBe(PO);
    ws.close();
    // a second person is a second identity on the same store: the engineer's roles bound their switcher
    const eng = await signIn(server, ENG);
    const e = await state(server, eng.cookie);
    expect(e.body.identity).toEqual({ id: ENG, name: "Eli Ng", roles: ["eng", "tech_lead"] });
    expect(server.auth?.sessions.size).toBe(2);
  });

  it("decisions commit under the signed-in identity, and a role the identity does not hold is refused as before", async () => {
    const { dir, server } = await hostedServer();
    const po = (await signIn(server, PO)).cookie ?? "";
    const eng = (await signIn(server, ENG)).cookie ?? "";
    const refused = await fetch(`${server.url}/api/changes/CHG-0022/accept`, { method: "POST", headers: { "content-type": "application/json", cookie: eng }, body: JSON.stringify({ gate: 1 }) });
    expect(refused.status).toBe(403);
    const ok = await fetch(`${server.url}/api/changes/CHG-0022/accept`, { method: "POST", headers: { "content-type": "application/json", cookie: po }, body: JSON.stringify({ gate: 1 }) });
    expect(ok.status).toBe(200);
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>"])).trim()).toBe(`Priya Owens <${PO}>`);
    const log = readFileSync(join(dir, "sdlc/changes/CHG-0022/log.jsonl"), "utf8");
    expect(log).toContain(`"actor":{"type":"human","id":"${PO}","role":"po"}`);
    // author and committer are the person, not the server's own identity
    expect((await git(dir, ["log", "-1", "--format=%cn <%ce>"])).trim()).toBe(`Priya Owens <${PO}>`);
  });

  it("someone the provider vouches for but the config does not list gets no session; a replayed callback and a signed-out cookie are refused", async () => {
    const { server } = await hostedServer();
    const stranger = await signIn(server, "stranger@veri.example");
    expect(stranger.final.status).toBe(403);
    expect(stranger.cookie).toBeNull();
    expect(await stranger.final.text()).toContain("lists no identity for it");
    // the callback's state is single-use
    const login = await fetch(`${server.url}/auth/login`, noRedirect);
    const authorize = new URL(login.headers.get("location") ?? "");
    authorize.searchParams.set("user", PO);
    const callback = (await fetch(authorize.toString(), noRedirect)).headers.get("location") ?? "";
    const first = await fetch(callback, noRedirect);
    expect(first.status).toBe(303);
    const replay = await fetch(callback, noRedirect);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("already used");
    // sign out forgets the session
    const cookie = `sdlc_session=${/sdlc_session=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
    expect((await state(server, cookie)).status).toBe(200);
    const out = await fetch(`${server.url}/auth/logout`, { ...noRedirect, headers: { cookie } });
    expect(out.status).toBe(303);
    const after = await state(server, cookie);
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ signedIn: "expired" });
  });

  it("a subject declared on an identity wins over the email claim, and a rotated provider key is picked up with one JWKS refresh", async () => {
    const { server, oidc } = await hostedServer();
    // map a provider subject onto the engineer explicitly: the stranger's email is not listed, its subject is
    const dir = server.root;
    const cfg = join(dir, "sdlc/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(`- id: ${ENG}\n`, `- id: ${ENG}\n    subject: sub-lead@veri.example\n`));
    await git(dir, ["commit", "-q", "-am", "sdlc(config): map a subject"]);
    await server.store.refresh(true);
    const lead = await signIn(server, "lead@veri.example");
    expect(lead.final.status).toBe(303);
    expect((await state(server, lead.cookie)).body.identity.id).toBe(ENG);
    oidc.rotateKey();
    const again = await signIn(server, PO);
    expect(again.final.status).toBe(303);
    expect(oidc.requests.filter((r) => r.path === "/jwks")).toHaveLength(2);
  });
});

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitIdentity } from "@sdlc/adapter-git";
import { identityForClaims, type ResolvedAuth, type ResolvedConfig } from "@sdlc/core";
import { authorizeUrl, discover, exchangeCode, fetchJwks, OidcError, pkce, randomToken, verifyIdToken, type Discovery, type FetchLike, type Jwks } from "./oidc.js";
import { AuthSessions, cookie, parseCookies, type AuthSession } from "./sessions.js";

export { AuthSessions, parseCookies } from "./sessions.js";
export { OidcError, verifyIdToken } from "./oidc.js";

export const SESSION_COOKIE = "sdlc_session";

export interface AuthenticatorOptions {
  auth: ResolvedAuth;
  /** The current config (identities) — read on every login so a config commit takes effect without a restart. */
  config: () => ResolvedConfig;
  /** Confidential clients pass the secret through `SDLC_OIDC_CLIENT_SECRET`; public clients rely on PKCE alone. */
  clientSecret?: string;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Hosted identity for `sdlc serve` (build-order 3.1): `/auth/login` sends the
 * browser to the OIDC provider, `/auth/callback` verifies the ID token and maps
 * its claims to an identity in `sdlc/config.yaml`, `/auth/logout` forgets the
 * session. Every `/api` request and the WebSocket then act as that identity —
 * the role switcher is bounded by the roles it holds, decisions commit under
 * it. Someone the provider vouches for but the config does not list gets a
 * page saying so and no session: config stays the only source of who may act.
 */
export class Authenticator {
  readonly sessions: AuthSessions<GitIdentity>;
  private discovery: Promise<Discovery> | null = null;
  private jwks: { keys: Jwks; at: number } | null = null;

  constructor(private readonly opts: AuthenticatorOptions) {
    this.sessions = new AuthSessions<GitIdentity>(() => (opts.now?.() ?? new Date()).getTime());
  }

  get provider(): ResolvedAuth {
    return this.opts.auth;
  }

  /** The identity behind a request's cookie, or null. */
  identityOf(req: IncomingMessage): GitIdentity | null {
    return this.session(req)?.identity ?? null;
  }

  session(req: IncomingMessage): AuthSession<GitIdentity> | null {
    return this.sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  /** `/auth/*` routes; false when the path is not one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/auth/login" && req.method === "GET") {
      await this.login(req, res, url);
      return true;
    }
    if (url.pathname === "/auth/callback" && req.method === "GET") {
      await this.callback(req, res, url);
      return true;
    }
    if (url.pathname === "/auth/logout" && (req.method === "GET" || req.method === "POST")) {
      const s = this.session(req);
      if (s) this.sessions.revoke(s.id);
      res.writeHead(303, { location: "/", "set-cookie": cookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: this.secure(req) }) });
      res.end();
      return true;
    }
    return false;
  }

  private origin(req: IncomingMessage): string {
    if (this.opts.auth.publicUrl) return this.opts.auth.publicUrl;
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
    const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host || "localhost";
    return `${proto}://${host}`;
  }

  private secure(req: IncomingMessage): boolean {
    return this.origin(req).startsWith("https://");
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= discover(this.opts.auth.issuer, this.opts.fetch).catch((e: unknown) => {
      this.discovery = null;
      throw e;
    });
    return this.discovery;
  }

  private async keys(disc: Discovery, refresh = false): Promise<Jwks> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (!refresh && this.jwks && now - this.jwks.at < 60 * 60 * 1000) return this.jwks.keys;
    const keys = await fetchJwks(disc, this.opts.fetch);
    this.jwks = { keys, at: now };
    return keys;
  }

  private async login(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const disc = await this.discover();
    const { verifier, challenge } = pkce();
    const returnTo = url.searchParams.get("return_to") ?? "/";
    const pending = this.sessions.startLogin(verifier, randomToken(16), returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/");
    const target = authorizeUrl(disc, { clientId: this.opts.auth.clientId, redirectUri: `${this.origin(req)}/auth/callback`, state: pending.state, nonce: pending.nonce, challenge, scopes: this.opts.auth.scopes });
    res.writeHead(302, { location: target, "cache-control": "no-store" });
    res.end();
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = this.sessions.takeLogin(state);
    if (!pending) return page(res, 400, "Sign-in expired", "This sign-in link was already used or is older than ten minutes.", "/auth/login", "Sign in again");
    const providerError = url.searchParams.get("error");
    if (providerError || code === "") return page(res, 400, "Sign-in refused", `The identity provider answered: ${providerError ?? "no code"}${url.searchParams.get("error_description") ? ` — ${url.searchParams.get("error_description") ?? ""}` : ""}.`, "/auth/login", "Try again");
    const disc = await this.discover();
    let claims;
    try {
      const { idToken } = await exchangeCode(disc, { clientId: this.opts.auth.clientId, ...(this.opts.clientSecret ? { clientSecret: this.opts.clientSecret } : {}), code, redirectUri: `${this.origin(req)}/auth/callback`, verifier: pending.verifier }, this.opts.fetch);
      const input = { issuer: disc.issuer, audience: this.opts.auth.audience, nonce: pending.nonce, now: (this.opts.now?.() ?? new Date()).getTime() };
      try {
        claims = verifyIdToken(idToken, await this.keys(disc), input);
      } catch (e) {
        // a rotated key: one JWKS refresh before giving up
        if (!(e instanceof OidcError) || !/JWKS|signature/.test(e.message)) throw e;
        claims = verifyIdToken(idToken, await this.keys(disc, true), input);
      }
    } catch (e) {
      this.opts.log?.(`auth: sign-in failed: ${(e as Error).message}`);
      return page(res, 502, "Sign-in failed", (e as Error).message, "/auth/login", "Try again");
    }
    const who = identityForClaims(this.opts.config(), claims);
    if (!who) {
      const shown = claims.email ?? claims.preferred_username ?? claims.sub;
      this.opts.log?.(`auth: ${shown} signed in at the provider but sdlc/config.yaml lists no identity for it`);
      return page(res, 403, "Not on the list", `${shown} is signed in at ${this.opts.auth.issuer}, but sdlc/config.yaml lists no identity for it. Ask a maintainer to add it under identities (with its roles) — the console never edits that file.`, "/auth/login", "Sign in as someone else");
    }
    const identity: GitIdentity = { id: who.id, name: who.name ?? (typeof claims.name === "string" ? claims.name : who.id) };
    const s = this.sessions.create(identity, claims.sub, this.opts.auth.sessionHours * 60 * 60 * 1000);
    this.opts.log?.(`auth: ${identity.id} signed in (${claims.sub})`);
    res.writeHead(303, { location: pending.returnTo, "set-cookie": cookie(SESSION_COOKIE, s.id, { maxAgeSeconds: this.opts.auth.sessionHours * 3600, secure: this.secure(req) }), "cache-control": "no-store" });
    res.end();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function page(res: ServerResponse, status: number, title: string, text: string, href: string, label: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)} · SDLC console</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#1a56db}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

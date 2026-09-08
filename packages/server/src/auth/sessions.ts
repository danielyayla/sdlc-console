import { randomToken } from "./oidc.js";

/**
 * The console's own sessions: an opaque id in an HttpOnly cookie, mapped in
 * memory to the identity the provider vouched for. Nothing is persisted —
 * a restart signs everyone out, which is the disposable-cache rule applied
 * to logins. Pending logins hold the PKCE verifier and nonce for ten minutes.
 */
export interface AuthSession<I> {
  id: string;
  identity: I;
  /** OIDC subject, for the sign-out page and the log. */
  subject: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingLogin {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

const PENDING_TTL = 10 * 60 * 1000;

export class AuthSessions<I> {
  private readonly sessions = new Map<string, AuthSession<I>>();
  private readonly pending = new Map<string, PendingLogin>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  startLogin(verifier: string, nonce: string, returnTo: string): PendingLogin {
    this.sweep();
    const login: PendingLogin = { state: randomToken(24), verifier, nonce, returnTo, expiresAt: this.now() + PENDING_TTL };
    this.pending.set(login.state, login);
    return login;
  }

  /** One use per state: a replayed callback finds nothing. */
  takeLogin(state: string): PendingLogin | null {
    const login = this.pending.get(state);
    if (!login) return null;
    this.pending.delete(state);
    return login.expiresAt > this.now() ? login : null;
  }

  create(identity: I, subject: string, ttlMs: number): AuthSession<I> {
    this.sweep();
    const s: AuthSession<I> = { id: randomToken(32), identity, subject, createdAt: this.now(), expiresAt: this.now() + ttlMs };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | null | undefined): AuthSession<I> | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.sessions) if (v.expiresAt <= t) this.sessions.delete(k);
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== "") out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opts.maxAgeSeconds}${opts.secure ? "; Secure" : ""}`;
}

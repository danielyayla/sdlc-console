import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GitIdentity } from "@sdlc/adapter-git";
import { GitHubClient } from "./client.js";
import type { Env } from "./remote.js";

/** A GitHub App installation: the App signs its own JWT, the installation token does the work. */
export interface GitHubAppCredentials {
  appId: string;
  /** PEM private key (RSA). */
  privateKey: string;
  installationId: string;
}

/**
 * `SDLC_GITHUB_APP_ID`, `SDLC_GITHUB_APP_INSTALLATION_ID` and the private key
 * as `SDLC_GITHUB_APP_PRIVATE_KEY` (PEM) or `SDLC_GITHUB_APP_PRIVATE_KEY_FILE`
 * (path). Null when none is set; a partial set is a configuration error, not
 * a silent fall-back to the token.
 */
export function appCredentialsFrom(env: Env): GitHubAppCredentials | null {
  const appId = env["SDLC_GITHUB_APP_ID"]?.trim();
  const installationId = env["SDLC_GITHUB_APP_INSTALLATION_ID"]?.trim();
  const file = env["SDLC_GITHUB_APP_PRIVATE_KEY_FILE"]?.trim();
  const inline = env["SDLC_GITHUB_APP_PRIVATE_KEY"];
  if (!appId && !installationId && !file && !inline) return null;
  if (!appId || !installationId || (!file && !inline)) {
    throw new Error("GitHub App mode needs SDLC_GITHUB_APP_ID, SDLC_GITHUB_APP_INSTALLATION_ID and SDLC_GITHUB_APP_PRIVATE_KEY (PEM) or SDLC_GITHUB_APP_PRIVATE_KEY_FILE — all three, or none for token mode");
  }
  const privateKey = inline && inline.trim() !== "" ? inline.replace(/\\n/g, "\n") : readFileSync(file ?? "", "utf8");
  return { appId, privateKey, installationId };
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** RS256 App JWT (GitHub allows 10 minutes; issued 60 s in the past against clock skew). */
export function signAppJwt(appId: string, privateKey: string, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const exp = iat + 60 + 9 * 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

export interface TokenSourceOptions {
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Refresh this long before `expires_at` (default 60 s). */
  earlyMs?: number;
}

interface RawInstallationToken {
  token: string;
  expires_at: string;
}

/**
 * Installation access tokens, minted from the App JWT and cached until they
 * are about to expire. Nothing here is persisted: a restart mints a new one.
 */
export class InstallationTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;
  private bot: GitIdentity | null = null;
  /** Times a token was minted (tests: caching). */
  mints = 0;

  constructor(
    readonly app: GitHubAppCredentials,
    private readonly opts: TokenSourceOptions = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** A client authenticated as the App itself (JWT): `/app`, `/app/installations/...`. */
  appClient(): GitHubClient {
    return new GitHubClient({ tokenSource: { token: () => Promise.resolve(signAppJwt(this.app.appId, this.app.privateKey, this.now())) }, ...(this.opts.apiUrl ? { apiUrl: this.opts.apiUrl } : {}), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) });
  }

  async token(): Promise<string> {
    const early = this.opts.earlyMs ?? 60_000;
    if (this.cached && this.cached.expiresAt - early > this.now().getTime()) return this.cached.token;
    if (this.minting) return this.minting;
    this.minting = (async () => {
      try {
        const r = await this.appClient().post<RawInstallationToken>(`/app/installations/${encodeURIComponent(this.app.installationId)}/access_tokens`, {});
        this.cached = { token: r.data.token, expiresAt: Date.parse(r.data.expires_at) };
        this.mints++;
        return r.data.token;
      } finally {
        this.minting = null;
      }
    })();
    return this.minting;
  }

  /**
   * The App's bot user as a git identity — the committer of every commit the
   * console makes on behalf of a person in hosted mode. `GET /app` gives the
   * slug; the bot user's id makes the noreply address GitHub links to the App.
   */
  async identity(): Promise<GitIdentity> {
    if (this.bot) return this.bot;
    const app = await this.appClient().get<{ id: number; slug: string }>("/app");
    const login = `${app.data.slug}[bot]`;
    const client = new GitHubClient({ tokenSource: this, ...(this.opts.apiUrl ? { apiUrl: this.opts.apiUrl } : {}), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) });
    const user = await client.get<{ id: number }>(`/users/${encodeURIComponent(login)}`).catch(() => null);
    const uid = user?.data.id ?? app.data.id;
    this.bot = { name: login, id: `${uid}+${login}@users.noreply.github.com` };
    return this.bot;
  }
}

const sources = new Map<string, InstallationTokenSource>();

/**
 * One token source per installation and API in the process: every host the
 * server builds (the engine's, an action's) shares the minted token instead
 * of each minting its own.
 */
export function installationTokenSource(app: GitHubAppCredentials, opts: TokenSourceOptions = {}): InstallationTokenSource {
  const key = `${opts.apiUrl ?? ""}|${app.appId}|${app.installationId}`;
  const existing = sources.get(key);
  if (existing && existing.app.privateKey === app.privateKey) return existing;
  const created = new InstallationTokenSource(app, opts);
  sources.set(key, created);
  return created;
}

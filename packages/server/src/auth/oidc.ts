import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

/**
 * OpenID Connect for `sdlc serve` in hosted mode (build-order 3.1): discovery,
 * the authorization-code flow with PKCE, and ID-token verification against the
 * provider's JWKS. No library: `fetch` and `node:crypto` are enough for
 * RS256/ES256, and nothing here stores a token — the verified claims map to an
 * identity in `sdlc/config.yaml` and only the console's own session id lives on.
 */
export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OidcError extends Error {}

export async function discover(issuer: string, fetchImpl: FetchLike = fetch): Promise<Discovery> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new OidcError(`OIDC discovery at ${url} answered ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  const need = (k: string): string => {
    const v = doc[k];
    if (typeof v !== "string" || v === "") throw new OidcError(`OIDC discovery at ${url} has no ${k}`);
    return v;
  };
  return { issuer: need("issuer"), authorizationEndpoint: need("authorization_endpoint"), tokenEndpoint: need("token_endpoint"), jwksUri: need("jwks_uri") };
}

const b64url = (b: Buffer): string => b.toString("base64url");

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** PKCE (RFC 7636): a verifier kept with the pending login, its S256 challenge sent to the provider. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  scopes: readonly string[];
}

export function authorizeUrl(disc: Discovery, input: AuthorizeInput): string {
  const u = new URL(disc.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("scope", input.scopes.join(" "));
  u.searchParams.set("state", input.state);
  u.searchParams.set("nonce", input.nonce);
  u.searchParams.set("code_challenge", input.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface ExchangeInput {
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  verifier: string;
}

/** Trade the code for tokens; only the ID token is used. */
export async function exchangeCode(disc: Discovery, input: ExchangeInput, fetchImpl: FetchLike = fetch): Promise<{ idToken: string }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: input.clientId, code_verifier: input.verifier });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const res = await fetchImpl(disc.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  if (!res.ok) throw new OidcError(`token endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== "string") throw new OidcError("token endpoint returned no id_token");
  return { idToken: json.id_token };
}

export interface Jwks {
  keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[];
}

export async function fetchJwks(disc: Discovery, fetchImpl: FetchLike = fetch): Promise<Jwks> {
  const res = await fetchImpl(disc.jwksUri);
  if (!res.ok) throw new OidcError(`JWKS at ${disc.jwksUri} answered ${res.status}`);
  const json = (await res.json()) as Jwks;
  if (!Array.isArray(json.keys)) throw new OidcError("JWKS has no keys");
  return json;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  [claim: string]: unknown;
}

export interface VerifyInput {
  issuer: string;
  audience: string;
  nonce: string;
  now?: number;
}

function decodePart(part: string, what: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (typeof v !== "object" || v === null) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new OidcError(`ID token ${what} is not valid JSON`);
  }
}

/** Verify the ID token's signature (RS256 / ES256 via JWKS), issuer, audience, expiry and nonce; returns the claims. */
export function verifyIdToken(token: string, jwks: Jwks, input: VerifyInput): IdClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("ID token is not a compact JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = decodePart(h, "header");
  const alg = header["alg"];
  if (alg !== "RS256" && alg !== "ES256") throw new OidcError(`ID token alg ${String(alg)} is not supported (RS256, ES256)`);
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const candidates = jwks.keys.filter((k) => (kid === null || k.kid === kid) && (!k.alg || k.alg === alg));
  if (candidates.length === 0) throw new OidcError(kid ? `no JWKS key with kid ${kid}` : "no JWKS key matches the ID token");
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return alg === "RS256" ? cryptoVerify("sha256", data, key, sig) : cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    } catch {
      return false;
    }
  });
  if (!ok) throw new OidcError("ID token signature does not verify");
  const claims = decodePart(p, "payload") as unknown as IdClaims;
  if (claims.iss !== input.issuer) throw new OidcError(`ID token issuer ${String(claims.iss)} is not ${input.issuer}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(input.audience)) throw new OidcError(`ID token audience does not include ${input.audience}`);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new OidcError("ID token has expired");
  if (claims.nonce !== input.nonce) throw new OidcError("ID token nonce does not match this login");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new OidcError("ID token has no subject");
  return claims;
}

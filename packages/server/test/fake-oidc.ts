import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An OpenID provider look-alike for the hosted-identity tests: discovery,
 * an authorize endpoint that signs in whichever `user` the query names and
 * sends the browser back with a code, a token endpoint that checks the PKCE
 * verifier and mints an RS256 ID token, and a JWKS. `rotateKey()` swaps the
 * signing key so the console's one-refresh retry can be exercised.
 */
export interface FakeOidc {
  url: string;
  clientId: string;
  requests: { method: string; path: string }[];
  /** Tokens minted, by code. */
  minted: { code: string; user: string; nonce: string }[];
  rotateKey: () => void;
  close: () => Promise<void>;
}

interface Pending {
  user: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
}

function b64url(s: Buffer | string): string {
  return Buffer.from(s).toString("base64url");
}

function jwk(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...(key.export({ format: "jwk" }) as Record<string, unknown>), kid, alg: "RS256", use: "sig" };
}

export async function startFakeOidc(opts: { clientId?: string; now?: () => number } = {}): Promise<FakeOidc> {
  const clientId = opts.clientId ?? "sdlc-console";
  let pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let kid = "k1";
  const pending = new Map<string, Pending>();
  const requests: FakeOidc["requests"] = [];
  const minted: FakeOidc["minted"] = [];
  let issuer = "";
  const now = opts.now ?? (() => Date.now());

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
    res.end(text);
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (data += c));
      req.on("end", () => resolve(data));
    });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer);
      requests.push({ method: req.method ?? "GET", path: url.pathname });
      if (url.pathname === "/.well-known/openid-configuration") {
        return send(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"] });
      }
      if (url.pathname === "/jwks") return send(res, 200, { keys: [jwk(pair.publicKey, kid)] });
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const user = q.get("user");
        const redirectUri = q.get("redirect_uri") ?? "";
        const state = q.get("state") ?? "";
        if (q.get("response_type") !== "code" || q.get("client_id") !== clientId || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("nonce")) {
          res.writeHead(302, { location: `${redirectUri}?state=${encodeURIComponent(state)}&error=invalid_request&error_description=${encodeURIComponent("bad authorize request")}` });
          return res.end();
        }
        if (!user) {
          res.writeHead(302, { location: `${redirectUri}?state=${encodeURIComponent(state)}&error=access_denied` });
          return res.end();
        }
        const code = randomBytes(12).toString("hex");
        pending.set(code, { user, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", redirectUri, clientId });
        res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const code = form.get("code") ?? "";
        const p = pending.get(code);
        if (!p || form.get("grant_type") !== "authorization_code") return send(res, 400, { error: "invalid_grant" });
        pending.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        if (b64url(createHash("sha256").update(verifier).digest()) !== p.challenge) return send(res, 400, { error: "invalid_grant", error_description: "PKCE verifier does not match" });
        if (form.get("redirect_uri") !== p.redirectUri || form.get("client_id") !== p.clientId) return send(res, 400, { error: "invalid_request" });
        const t = Math.floor(now() / 1000);
        const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
        const payload = b64url(JSON.stringify({ iss: issuer, sub: `sub-${p.user}`, aud: clientId, exp: t + 3600, iat: t, nonce: p.nonce, email: p.user, email_verified: true, name: p.user.split("@")[0] }));
        const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pair.privateKey);
        minted.push({ code, user: p.user, nonce: p.nonce });
        return send(res, 200, { id_token: `${header}.${payload}.${b64url(sig)}`, token_type: "Bearer", access_token: randomBytes(8).toString("hex") }, { "cache-control": "no-store" });
      }
      send(res, 404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: issuer,
    clientId,
    requests,
    minted,
    rotateKey: () => {
      pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      kid = `k${Number(kid.slice(1)) + 1}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import { createVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRaw } from "@sdlc/adapter-git";

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  merged_by: string | null;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  output: Record<string, unknown>;
}

export interface FakeState {
  protected: boolean;
  pulls: FakePull[];
  statuses: { sha: string; body: Record<string, unknown> }[];
  reviews: { number: number; body: Record<string, unknown> }[];
  comments: { number: number; body: string }[];
  requests: { method: string; path: string; auth: string | null }[];
  /** GitHub computes mergeability after a push: while > 0, `GET /pulls/:n` reports `mergeable_state: unknown` (decrementing) and the merge answers 405. */
  mergeabilityPending: number;
  /** App mode: check runs (`POST /check-runs`, `PATCH /check-runs/:id`), newest first per head as GitHub lists them. */
  checkRuns: FakeCheckRun[];
  /** App mode: installation tokens minted so far (`ghs_<n>`) with their expiry. */
  installationTokens: { token: string; expiresAt: number }[];
  /** App mode: JWTs that verified against the App's public key. */
  jwtsAccepted: number;
}

/** A GitHub App installed on the fake: the JWT must verify against `publicKey` and carry `iss: id`. */
export interface FakeApp {
  id: number;
  slug: string;
  installationId: number;
  publicKey: string;
  /** Token lifetime (GitHub: 1 h); short in tests to prove the refresh. */
  tokenTtlMs?: number;
}

export interface FakeGitHub {
  url: string;
  token: string;
  owner: string;
  repo: string;
  bare: string;
  state: FakeState;
  app: FakeApp | null;
  close(): Promise<void>;
}

/** Verify an RS256 JWT against the App's public key; the payload when it verifies and `iss` matches, else null. */
function verifyAppJwt(jwt: string, app: FakeApp): { iss: string; iat: number; exp: number } | null {
  const [head, body, sig] = jwt.split(".");
  if (!head || !body || !sig) return null;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: string };
    if (header.alg !== "RS256") return null;
    const ok = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(app.publicKey, Buffer.from(sig, "base64url"));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
    if (String(payload.iss) !== String(app.id)) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * A GitHub REST look-alike backed by a bare repository: pulls, merges (real
 * git merges pushed to the bare repo), statuses, reviews, comments, and the
 * branch resource with its `protected` flag. Enough to prove the adapter
 * without a network.
 */
export async function startFakeGitHub(opts: { bare: string; owner?: string; repo?: string; token?: string; protected?: boolean; app?: FakeApp }): Promise<FakeGitHub> {
  const owner = opts.owner ?? "acme";
  const repo = opts.repo ?? "widgets";
  const token = opts.token ?? "ghp_test";
  const app = opts.app ?? null;
  const state: FakeState = { protected: opts.protected ?? true, pulls: [], statuses: [], reviews: [], comments: [], requests: [], mergeabilityPending: 0, checkRuns: [], installationTokens: [], jwtsAccepted: 0 };
  const prefix = `/repos/${owner}/${repo}`;
  // when the fake recorded a status or review, served as created_at/updated_at/submitted_at unless the body carries its own
  const recordedAt = new WeakMap<object, string>();
  const record = <T extends object>(entry: T): T => {
    recordedAt.set(entry, new Date().toISOString());
    return entry;
  };

  const headOf = async (ref: string): Promise<string | null> => {
    const r = await gitRaw(opts.bare, ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const pullJson = async (p: FakePull): Promise<Record<string, unknown>> => ({
    number: p.number,
    html_url: `https://github.example/${owner}/${repo}/pull/${p.number}`,
    state: p.state,
    merged: p.merged,
    merge_commit_sha: p.merge_commit_sha,
    head: { sha: (await headOf(p.head)) ?? "0".repeat(40), ref: p.head },
    base: { ref: p.base },
    requested_reviewers: [],
    merged_by: p.merged_by ? { login: p.merged_by } : null,
    draft: false,
    mergeable_state: state.protected ? "blocked" : "clean",
  });

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let text = "";
      req.on("data", (c: Buffer) => (text += c.toString("utf8")));
      req.on("end", () => resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {}));
    });
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const [path = "/", query = ""] = (req.url ?? "/").split("?");
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    state.requests.push({ method, path, auth });
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    // who is calling: the PAT, an unexpired installation token, or the App's own JWT
    const asApp = bearer && app && bearer.includes(".") ? verifyAppJwt(bearer, app) : null;
    const asInstallation = bearer ? state.installationTokens.find((t) => t.token === bearer && t.expiresAt > Date.now()) : undefined;
    const asToken = bearer === token;
    const body = method === "GET" ? {} : await readBody(req);
    let m: RegExpExecArray | null;

    // App endpoints (JWT only)
    if (path === "/app" || path.startsWith("/app/")) {
      if (!asApp || !app) return send(res, 401, { message: "A JSON web token could not be decoded" });
      state.jwtsAccepted++;
      if (method === "GET" && path === "/app") return send(res, 200, { id: app.id, slug: app.slug, name: app.slug, owner: { login: owner } });
      if (method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
        if (Number(m[1]) !== app.installationId) return send(res, 404, { message: "Not Found" });
        const minted = { token: `ghs_${state.installationTokens.length + 1}`, expiresAt: Date.now() + (app.tokenTtlMs ?? 3_600_000) };
        state.installationTokens.push(minted);
        return send(res, 201, { token: minted.token, expires_at: new Date(minted.expiresAt).toISOString(), permissions: { checks: "write", contents: "write", pull_requests: "write" } });
      }
      return send(res, 404, { message: `no route ${method} ${path}` });
    }
    if (!asToken && !asInstallation) return send(res, 401, { message: "Bad credentials" });
    if (method === "GET" && (m = /^\/users\/([^/]+)$/.exec(path))) {
      const login = decodeURIComponent(m[1] ?? "");
      if (app && login === `${app.slug}[bot]`) return send(res, 200, { login, id: 90_000 + app.id, type: "Bot" });
      return send(res, 200, { login, id: 1, type: "User" });
    }
    if (!path.startsWith(prefix)) return send(res, 404, { message: "Not Found" });
    const rest = path.slice(prefix.length);
    const actor = asInstallation && app ? `${app.slug}[bot]` : "token-user";

    // check runs need the App: a PAT is refused the way GitHub refuses it
    if (rest === "/check-runs" && method === "POST") {
      if (!asInstallation) return send(res, 403, { message: "Resource not accessible by personal access token" });
      const run: FakeCheckRun = { id: state.checkRuns.length + 1, name: String(body["name"]), head_sha: String(body["head_sha"]), status: String(body["status"] ?? "queued"), conclusion: typeof body["conclusion"] === "string" ? body["conclusion"] : null, details_url: typeof body["details_url"] === "string" ? body["details_url"] : null, output: (body["output"] as Record<string, unknown>) ?? {} };
      state.checkRuns.unshift(run);
      return send(res, 201, { ...run, html_url: `https://github.example/${owner}/${repo}/runs/${run.id}` });
    }
    if ((m = /^\/check-runs\/(\d+)$/.exec(rest)) && method === "PATCH") {
      if (!asInstallation) return send(res, 403, { message: "Resource not accessible by personal access token" });
      const run = state.checkRuns.find((r) => r.id === Number(m?.[1]));
      if (!run) return send(res, 404, { message: "Not Found" });
      if (typeof body["status"] === "string") run.status = body["status"];
      if (typeof body["conclusion"] === "string") run.conclusion = body["conclusion"];
      if (typeof body["details_url"] === "string") run.details_url = body["details_url"];
      if (body["output"] && typeof body["output"] === "object") run.output = { ...run.output, ...(body["output"] as Record<string, unknown>) };
      return send(res, 200, { ...run, html_url: `https://github.example/${owner}/${repo}/runs/${run.id}` });
    }
    if ((m = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest)) && method === "GET") {
      const q = new URLSearchParams(query);
      const name = q.get("check_name");
      const runs = state.checkRuns.filter((r) => r.head_sha === m?.[1] && (!name || r.name === name));
      return send(res, 200, { total_count: runs.length, check_runs: runs.map((r) => ({ ...r, html_url: `https://github.example/${owner}/${repo}/runs/${r.id}` })) });
    }
    if (method === "GET" && (m = /^\/branches\/([^/]+)$/.exec(rest))) {
      const name = decodeURIComponent(m[1] ?? "");
      const sha = await headOf(name);
      if (!sha) return send(res, 404, { message: "Branch not found" });
      return send(res, 200, { name, commit: { sha }, protected: state.protected });
    }
    if (method === "GET" && rest === "/pulls") {
      const q = new URLSearchParams(query);
      const head = q.get("head")?.split(":")[1];
      const st = q.get("state") ?? "open";
      const hits = state.pulls.filter((p) => (st === "all" || p.state === st) && (!head || p.head === head));
      return send(res, 200, await Promise.all(hits.map((p) => pullJson(p))));
    }
    if (method === "POST" && rest === "/pulls") {
      const head = String(body["head"]);
      const base = String(body["base"]);
      if (!(await headOf(head))) return send(res, 422, { message: "Validation Failed", errors: [{ message: `head ${head} is invalid` }] });
      if (state.pulls.some((p) => p.head === head && p.state === "open")) return send(res, 422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${head}.` }] });
      const pull: FakePull = { number: state.pulls.length + 1, title: String(body["title"]), body: String(body["body"] ?? ""), head, base, state: "open", merged: false, merge_commit_sha: null, merged_by: null };
      state.pulls.push(pull);
      return send(res, 201, await pullJson(pull));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest)) && method === "GET") {
      const pull = state.pulls[Number(m[1]) - 1];
      if (!pull) return send(res, 404, { message: "Not Found" });
      if (state.mergeabilityPending > 0) {
        state.mergeabilityPending--;
        return send(res, 200, { ...(await pullJson(pull)), mergeable_state: "unknown" });
      }
      return send(res, 200, await pullJson(pull));
    }
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === "PUT") {
      const pull = state.pulls[Number(m[1]) - 1];
      if (!pull) return send(res, 404, { message: "Not Found" });
      if (pull.merged || state.mergeabilityPending > 0) return send(res, 405, { message: "Pull Request is not mergeable" });
      const head = await headOf(pull.head);
      if (typeof body["sha"] === "string" && body["sha"] !== head) return send(res, 409, { message: "Head branch was modified. Review and try the merge again." });
      const clone = mkdtempSync(join(tmpdir(), "fake-gh-merge-"));
      try {
        await git(clone, ["clone", "-q", opts.bare, "."]);
        await git(clone, ["config", "user.email", "noreply@github.example"]);
        await git(clone, ["config", "user.name", "GitHub"]);
        await git(clone, ["checkout", "-q", pull.base]);
        await git(clone, ["merge", "--no-ff", "-q", "-m", String(body["commit_title"] ?? `Merge pull request #${pull.number}`), `origin/${pull.head}`]);
        await git(clone, ["push", "-q", "origin", pull.base]);
        const sha = (await git(clone, ["rev-parse", "HEAD"])).trim();
        pull.merged = true;
        pull.state = "closed";
        pull.merge_commit_sha = sha;
        pull.merged_by = typeof req.headers["x-fake-login"] === "string" ? req.headers["x-fake-login"] : actor;
        return send(res, 200, { sha, merged: true, message: "Pull Request successfully merged" });
      } catch (e) {
        return send(res, 405, { message: `merge failed: ${(e as Error).message}` });
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    }
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest)) && method === "POST") {
      state.reviews.push(record({ number: Number(m[1]), body }));
      return send(res, 200, { id: state.reviews.length, state: body["event"] });
    }
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest)) && method === "GET") {
      const n = Number(m[1]);
      const reviews = state.reviews.map((r, i) => ({ id: i + 1, number: r.number, submitted_at: recordedAt.get(r) ?? null, user: recordedAt.has(r) ? { login: "token-user" } : null, ...r.body, state: r.body["state"] ?? (r.body["event"] === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : r.body["event"] === "APPROVE" ? "APPROVED" : "COMMENTED") }));
      return send(res, 200, reviews.filter((r) => r.number === n));
    }
    if ((m = /^\/commits\/([0-9a-f]{40})\/status$/.exec(rest)) && method === "GET") {
      const sha = m[1] ?? "";
      const latest = new Map<string, Record<string, unknown>>();
      for (const s of state.statuses) if (s.sha === sha) latest.set(String(s.body["context"]), { created_at: recordedAt.get(s) ?? null, updated_at: recordedAt.get(s) ?? null, ...s.body });
      const statuses = [...latest.values()];
      const states = statuses.map((s) => String(s["state"]));
      const combined = states.length === 0 ? "pending" : states.some((x) => x === "failure" || x === "error") ? "failure" : states.every((x) => x === "success") ? "success" : "pending";
      return send(res, 200, { state: combined, sha, statuses });
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest)) && method === "POST") {
      state.comments.push({ number: Number(m[1]), body: String(body["body"]) });
      return send(res, 201, { id: state.comments.length });
    }
    if ((m = /^\/statuses\/([0-9a-f]{40})$/.exec(rest)) && method === "POST") {
      state.statuses.push(record({ sha: m[1] ?? "", body }));
      return send(res, 201, { id: state.statuses.length, ...body });
    }
    return send(res, 404, { message: `no route ${method} ${rest}` });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => send(res, 500, { message: e.message }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    owner,
    repo,
    bare: opts.bare,
    state,
    app,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

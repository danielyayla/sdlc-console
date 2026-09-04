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

export interface FakeState {
  protected: boolean;
  pulls: FakePull[];
  statuses: { sha: string; body: Record<string, unknown> }[];
  reviews: { number: number; body: Record<string, unknown> }[];
  comments: { number: number; body: string }[];
  requests: { method: string; path: string; auth: string | null }[];
}

export interface FakeGitHub {
  url: string;
  token: string;
  owner: string;
  repo: string;
  bare: string;
  state: FakeState;
  close(): Promise<void>;
}

/**
 * A GitHub REST look-alike backed by a bare repository: pulls, merges (real
 * git merges pushed to the bare repo), statuses, reviews, comments, and the
 * branch resource with its `protected` flag. Enough to prove the adapter
 * without a network.
 */
export async function startFakeGitHub(opts: { bare: string; owner?: string; repo?: string; token?: string; protected?: boolean }): Promise<FakeGitHub> {
  const owner = opts.owner ?? "acme";
  const repo = opts.repo ?? "widgets";
  const token = opts.token ?? "ghp_test";
  const state: FakeState = { protected: opts.protected ?? true, pulls: [], statuses: [], reviews: [], comments: [], requests: [] };
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
    if (auth !== `Bearer ${token}`) return send(res, 401, { message: "Bad credentials" });
    if (!path.startsWith(prefix)) return send(res, 404, { message: "Not Found" });
    const rest = path.slice(prefix.length);
    const body = method === "GET" ? {} : await readBody(req);

    let m: RegExpExecArray | null;
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
      return pull ? send(res, 200, await pullJson(pull)) : send(res, 404, { message: "Not Found" });
    }
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === "PUT") {
      const pull = state.pulls[Number(m[1]) - 1];
      if (!pull) return send(res, 404, { message: "Not Found" });
      if (pull.merged) return send(res, 405, { message: "Pull Request is not mergeable" });
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
        pull.merged_by = typeof req.headers["x-fake-login"] === "string" ? req.headers["x-fake-login"] : "token-user";
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
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRaw } from "@sdlc/adapter-git";

export interface FakeMergeRequest {
  iid: number;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  /** opened | merged | closed */
  state: "opened" | "merged" | "closed";
  merge_commit_sha: string | null;
  merged_by: string | null;
}

export interface FakeGitLabState {
  protected: boolean;
  mergeRequests: FakeMergeRequest[];
  /** `POST /projects/:id/statuses/:sha` bodies, in order. */
  statuses: { sha: string; body: Record<string, unknown> }[];
  /** MR notes (`POST /merge_requests/:iid/notes`), in order. */
  notes: { iid: number; body: string }[];
  requests: { method: string; path: string; privateToken: string | null; jobToken: string | null }[];
  /** GitLab computes mergeability after a push: while > 0, `GET /merge_requests/:iid` reports `detailed_merge_status: checking` (decrementing) and the merge answers 405. */
  mergeabilityPending: number;
}

export interface FakeGitLab {
  url: string;
  token: string;
  /** A CI job token: statuses only, refused (403) for merge requests as GitLab refuses it. */
  jobToken: string;
  projectId: number;
  /** `namespace/project`, nested namespaces allowed. */
  path: string;
  bare: string;
  state: FakeGitLabState;
  close(): Promise<void>;
}

/**
 * A GitLab REST v4 look-alike backed by a bare repository: the project,
 * branches with their `protected` flag, merge requests, merges (real git
 * merges pushed to the bare repo), commit statuses and notes. Enough to
 * prove the adapter without a network.
 */
export async function startFakeGitLab(opts: { bare: string; path?: string; projectId?: number; token?: string; jobToken?: string; protected?: boolean }): Promise<FakeGitLab> {
  const path = opts.path ?? "acme/widgets";
  const projectId = opts.projectId ?? 42;
  const token = opts.token ?? "glpat-test";
  const jobToken = opts.jobToken ?? "glcbt-job";
  const state: FakeGitLabState = { protected: opts.protected ?? true, mergeRequests: [], statuses: [], notes: [], requests: [], mergeabilityPending: 0 };
  const webBase = `https://gitlab.example/${path}`;
  const recordedAt = new WeakMap<object, string>();
  const record = <T extends object>(entry: T): T => {
    recordedAt.set(entry, new Date().toISOString());
    return entry;
  };

  const headOf = async (ref: string): Promise<string | null> => {
    const r = await gitRaw(opts.bare, ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const mrJson = async (m: FakeMergeRequest, checking = false): Promise<Record<string, unknown>> => ({
    id: 1000 + m.iid,
    iid: m.iid,
    project_id: projectId,
    title: m.title,
    description: m.description,
    state: m.state,
    sha: (await headOf(m.source_branch)) ?? "0".repeat(40),
    merge_commit_sha: m.merge_commit_sha,
    source_branch: m.source_branch,
    target_branch: m.target_branch,
    web_url: `${webBase}/-/merge_requests/${m.iid}`,
    reviewers: [],
    merge_user: m.merged_by ? { username: m.merged_by } : null,
    draft: false,
    detailed_merge_status: checking ? "checking" : m.state === "merged" ? "not_open" : state.protected ? "mergeable" : "mergeable",
    has_conflicts: false,
  });

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text === "" ? {} : (JSON.parse(text) as Record<string, unknown>));
        } catch (e) {
          reject(e as Error);
        }
      });
      req.on("error", reject);
    });
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://fake");
    const privateToken = typeof req.headers["private-token"] === "string" ? req.headers["private-token"] : null;
    const job = typeof req.headers["job-token"] === "string" ? req.headers["job-token"] : null;
    state.requests.push({ method, path: url.pathname, privateToken, jobToken: job });
    if (typeof req.headers.authorization === "string" || url.searchParams.has("private_token") || url.searchParams.has("access_token")) return send(res, 401, { message: "401 Unauthorized — tokens travel in PRIVATE-TOKEN / JOB-TOKEN headers only" });
    const asPrivate = privateToken === token;
    const asJob = job === jobToken;
    if (!asPrivate && !asJob) return send(res, 401, { message: "401 Unauthorized" });
    const body = method === "POST" || method === "PUT" ? await readBody(req) : {};
    const segments = url.pathname.split("/").filter((s) => s !== "");
    if (segments[0] !== "projects" || !segments[1]) return send(res, 404, { message: "404 Not Found" });
    const ref = decodeURIComponent(segments[1]);
    if (ref !== path && ref !== String(projectId)) return send(res, 404, { message: "404 Project Not Found" });
    const rest = segments.slice(2).map((s) => decodeURIComponent(s));
    const actor = asPrivate ? (typeof req.headers["x-fake-username"] === "string" ? req.headers["x-fake-username"] : "token-user") : "ci-job";

    if (rest.length === 0 && method === "GET") return send(res, 200, { id: projectId, path_with_namespace: path, name: path.split("/").at(-1), default_branch: "main", web_url: webBase });
    if (rest[0] === "repository" && rest[1] === "branches" && rest[2] && rest.length === 3 && method === "GET") {
      const sha = await headOf(rest[2]);
      if (!sha) return send(res, 404, { message: "404 Branch Not Found" });
      return send(res, 200, { name: rest[2], protected: state.protected, default: rest[2] === "main", commit: { id: sha } });
    }
    if (rest[0] === "protected_branches" && rest[1] && rest.length === 2 && method === "GET") {
      if (!state.protected) return send(res, 404, { message: "404 Not found" });
      return send(res, 200, { id: 1, name: rest[1], push_access_levels: [], merge_access_levels: [{ access_level: 40 }] });
    }
    if (rest[0] === "repository" && rest[1] === "commits" && rest[2] && rest[3] === "statuses" && method === "GET") {
      const sha = rest[2];
      const rows = state.statuses.filter((s) => s.sha === sha).map((s, i) => ({ id: i + 1, sha, name: s.body["name"], status: s.body["state"], description: s.body["description"] ?? null, target_url: s.body["target_url"] ?? null, created_at: recordedAt.get(s) ?? null, finished_at: recordedAt.get(s) ?? null }));
      return send(res, 200, rows);
    }
    if (rest[0] === "statuses" && rest[1] && rest.length === 2 && method === "POST") {
      if (!/^[0-9a-f]{40}$/.test(rest[1])) return send(res, 404, { message: "404 Commit Not Found" });
      if (typeof body["name"] !== "string" || typeof body["state"] !== "string") return send(res, 400, { message: "state is missing, name is missing" });
      state.statuses.push(record({ sha: rest[1], body }));
      return send(res, 201, { id: state.statuses.length, sha: rest[1], status: body["state"], name: body["name"], description: body["description"] ?? null, target_url: body["target_url"] ?? null });
    }
    if (rest[0] === "merge_requests") {
      // a CI job token cannot open, read or merge merge requests: GitLab answers 403 (the adapter says so up front)
      if (!asPrivate) return send(res, 403, { message: "403 Forbidden — job token" });
      if (rest.length === 1 && method === "GET") {
        const st = url.searchParams.get("state") ?? "all";
        const source = url.searchParams.get("source_branch");
        const hits = state.mergeRequests.filter((m) => (st === "all" || m.state === st) && (!source || m.source_branch === source));
        return send(res, 200, await Promise.all(hits.map((m) => mrJson(m))));
      }
      if (rest.length === 1 && method === "POST") {
        const source = String(body["source_branch"]);
        const target = String(body["target_branch"]);
        if (!(await headOf(source))) return send(res, 400, { message: { base: [`Source branch "${source}" does not exist`] } });
        if (state.mergeRequests.some((m) => m.source_branch === source && m.state === "opened")) return send(res, 409, { message: [`Another open merge request already exists for this source branch: !${state.mergeRequests.find((m) => m.source_branch === source)?.iid}`] });
        const mr: FakeMergeRequest = { iid: state.mergeRequests.length + 1, title: String(body["title"]), description: String(body["description"] ?? ""), source_branch: source, target_branch: target, state: "opened", merge_commit_sha: null, merged_by: null };
        state.mergeRequests.push(mr);
        return send(res, 201, await mrJson(mr));
      }
      const mr = state.mergeRequests[Number(rest[1]) - 1];
      if (!mr) return send(res, 404, { message: "404 Not found" });
      if (rest.length === 2 && method === "GET") {
        if (state.mergeabilityPending > 0) {
          state.mergeabilityPending--;
          return send(res, 200, await mrJson(mr, true));
        }
        return send(res, 200, await mrJson(mr));
      }
      if (rest[2] === "merge" && method === "PUT") {
        if (mr.state !== "opened" || state.mergeabilityPending > 0) return send(res, 405, { message: "405 Method Not Allowed" });
        const head = await headOf(mr.source_branch);
        if (typeof body["sha"] === "string" && body["sha"] !== head) return send(res, 409, { message: "SHA does not match HEAD of source branch" });
        const clone = mkdtempSync(join(tmpdir(), "fake-gl-merge-"));
        try {
          await git(clone, ["clone", "-q", opts.bare, "."]);
          await git(clone, ["config", "user.email", "noreply@gitlab.example"]);
          await git(clone, ["config", "user.name", "GitLab"]);
          await git(clone, ["checkout", "-q", mr.target_branch]);
          await git(clone, ["merge", "--no-ff", "-q", "-m", String(body["merge_commit_message"] ?? `Merge branch '${mr.source_branch}' into '${mr.target_branch}'`), `origin/${mr.source_branch}`]);
          await git(clone, ["push", "-q", "origin", mr.target_branch]);
          const sha = (await git(clone, ["rev-parse", "HEAD"])).trim();
          mr.state = "merged";
          mr.merge_commit_sha = sha;
          mr.merged_by = actor;
          return send(res, 200, await mrJson(mr));
        } catch (e) {
          return send(res, 406, { message: `Branch cannot be merged: ${(e as Error).message}` });
        } finally {
          rmSync(clone, { recursive: true, force: true });
        }
      }
      if (rest[2] === "notes" && method === "POST") {
        state.notes.push({ iid: mr.iid, body: String(body["body"]) });
        return send(res, 201, { id: state.notes.length, body: body["body"], author: { username: actor } });
      }
      if (rest[2] === "notes" && method === "GET") return send(res, 200, state.notes.filter((n) => n.iid === mr.iid).map((n, i) => ({ id: i + 1, body: n.body })));
    }
    return send(res, 404, { message: `no route ${method} ${url.pathname}` });
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
    jobToken,
    projectId,
    path,
    bare: opts.bare,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

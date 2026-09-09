/** How the request is authenticated: a personal/project/group access token (`PRIVATE-TOKEN`) or a CI job token (`JOB-TOKEN`). */
export type GitLabTokenKind = "private" | "job";

export interface GitLabClientOptions {
  token: string;
  /** Default `private`. A job token (`CI_JOB_TOKEN`) can publish statuses on its own project but cannot open or merge merge requests. */
  tokenKind?: GitLabTokenKind;
  /** REST v4 base URL; `CI_API_V4_URL` (default https://gitlab.com/api/v4). */
  apiUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface GitLabResponse<T> {
  status: number;
  data: T;
}

/**
 * A non-2xx answer from the API. `retryable` marks transient or precondition
 * failures: 5xx, 429, and the merge answers 405 (cannot be merged right now —
 * protection, a pipeline still running, mergeability being computed),
 * 406 (branch cannot be merged: conflicts) and 409 (sha does not match the
 * source branch head) — the same outcomes GitHub's 405/409 map to.
 */
export class GitLabError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`GitLab ${method} ${path} → ${status}${detail ? `: ${detail}` : ""}`);
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 405 || this.status === 406 || this.status === 409 || this.status === 429;
  }
}

/** GitLab answers `{message}` (a string, or an object of field → messages) or `{error}`. */
function messageOf(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: unknown };
    if (typeof b.message === "string") return b.message;
    if (b.message && typeof b.message === "object") {
      return Object.entries(b.message as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("; ");
    }
    if (typeof b.error === "string") return b.error;
    return "";
  }
  return typeof body === "string" ? body : "";
}

/** Minimal REST v4 client: JSON in, JSON out, the token in a header only (`PRIVATE-TOKEN` / `JOB-TOKEN`), never in a URL. */
export class GitLabClient {
  readonly apiUrl: string;
  readonly tokenKind: GitLabTokenKind;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: GitLabClientOptions) {
    if (!opts.token) throw new Error("GitLab client needs a token");
    this.token = opts.token;
    this.tokenKind = opts.tokenKind ?? "private";
    this.apiUrl = (opts.apiUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.userAgent = opts.userAgent ?? "sdlc-console";
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<GitLabResponse<T>> {
    const url = `${this.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
      [this.tokenKind === "job" ? "JOB-TOKEN" : "PRIVATE-TOKEN"]: this.token,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let data: unknown = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.status < 200 || res.status >= 300) throw new GitLabError(method, path, res.status, messageOf(data));
    return { status: res.status, data: data as T };
  }

  get<T>(path: string): Promise<GitLabResponse<T>> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<GitLabResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<GitLabResponse<T>> {
    return this.request<T>("PUT", path, body);
  }
}

export interface GitHubClientOptions {
  token: string;
  /** REST base URL; `GITHUB_API_URL` (default https://api.github.com). */
  apiUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
}

/** A non-2xx answer from the API. `retryable` marks transient or precondition failures (5xx, 405 not mergeable, 409 head moved). */
export class GitHubError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`GitHub ${method} ${path} → ${status}${detail ? `: ${detail}` : ""}`);
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 405 || this.status === 409 || this.status === 429;
  }
}

function messageOf(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; errors?: unknown };
    const parts: string[] = [];
    if (typeof b.message === "string") parts.push(b.message);
    if (Array.isArray(b.errors)) {
      for (const e of b.errors) {
        if (typeof e === "string") parts.push(e);
        else if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") parts.push((e as { message: string }).message);
      }
    }
    return parts.join("; ");
  }
  return typeof body === "string" ? body : "";
}

/** Minimal REST client: JSON in, JSON out, token in the Authorization header only. */
export class GitHubClient {
  readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: GitHubClientOptions) {
    if (!opts.token) throw new Error("GitHub client needs a token");
    this.token = opts.token;
    this.apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.userAgent = opts.userAgent ?? "sdlc-console";
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
    const url = `${this.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
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
    if (res.status < 200 || res.status >= 300) throw new GitHubError(method, path, res.status, messageOf(data));
    return { status: res.status, data: data as T };
  }

  get<T>(path: string): Promise<GitHubResponse<T>> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>("PUT", path, body);
  }
}

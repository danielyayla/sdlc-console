import type { Snapshot } from "@sdlc/server";

export interface ActionReply {
  ok: true;
  commit: string;
  changeId: string | null;
  toast: string;
  revision: number;
}

export interface ActionFailure {
  error: string;
  diagnostics?: { rule: string; message: string; path?: string }[];
  retryable?: boolean;
  status: number;
}

/** Query string addressing the product in view (3.2); empty for the server's primary product. */
export function productQuery(product: string | null): string {
  return product ? `?product=${encodeURIComponent(product)}` : "";
}

export interface ProductInfo {
  name: string;
  root: string;
  home: string;
  prefix: string;
  primary: boolean;
  codeHost: string;
  defaultBranch: string | null;
  engine: boolean;
}

export async function fetchProducts(): Promise<{ current: string; products: ProductInfo[] }> {
  return (await (await fetch("/api/products")).json()) as { current: string; products: ProductInfo[] };
}

export async function act(path: string, body: unknown = {}, product: string | null = null): Promise<ActionReply | ActionFailure> {
  const r = await fetch(`/api${path}${productQuery(product)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) location.assign("/auth/login");
  const data = (await r.json()) as ActionReply | Omit<ActionFailure, "status">;
  if (r.ok) return data as ActionReply;
  return { ...(data as Omit<ActionFailure, "status">), status: r.status };
}

export interface Artifact {
  index: number;
  name: string;
  path?: string;
  present?: boolean;
  body: string | null;
  frontMatter: Record<string, unknown> | null;
  files?: { path: string; body: string }[];
}

export async function fetchArtifact(id: string, index: number, product: string | null = null): Promise<Artifact> {
  const r = await fetch(`/api/changes/${id}/artifacts/${index}${productQuery(product)}`);
  return (await r.json()) as Artifact;
}

export async function fetchState(product: string | null = null): Promise<Snapshot> {
  return (await (await fetch(`/api/state${productQuery(product)}`)).json()) as Snapshot;
}

/** Subscribe to one product's snapshots; reconnects with backoff. Returns a stop function. */
export function subscribe(onSnapshot: (s: Snapshot) => void, onStatus: (connected: boolean) => void, product: string | null = null): () => void {
  let stopped = false;
  let delay = 500;
  let socket: WebSocket | null = null;
  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/api/events${productQuery(product)}`);
    socket.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; snapshot?: Snapshot };
      if (msg.type === "snapshot" && msg.snapshot) onSnapshot(msg.snapshot);
    };
    socket.onclose = (ev) => {
      onStatus(false);
      if (ev.code === 4401) {
        // hosted mode: no session — the provider signs us in and sends us back here
        stopped = true;
        location.assign(`/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`);
        return;
      }
      if (!stopped) setTimeout(connect, Math.min(delay *= 2, 8000));
    };
    socket.onerror = () => socket?.close();
  };
  connect();
  return () => {
    stopped = true;
    socket?.close();
  };
}

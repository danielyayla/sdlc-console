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

export async function act(path: string, body: unknown = {}): Promise<ActionReply | ActionFailure> {
  const r = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

export async function fetchArtifact(id: string, index: number): Promise<Artifact> {
  const r = await fetch(`/api/changes/${id}/artifacts/${index}`);
  return (await r.json()) as Artifact;
}

export async function fetchState(): Promise<Snapshot> {
  return (await (await fetch("/api/state")).json()) as Snapshot;
}

/** Subscribe to snapshots; reconnects with backoff. Returns a stop function. */
export function subscribe(onSnapshot: (s: Snapshot) => void, onStatus: (connected: boolean) => void): () => void {
  let stopped = false;
  let delay = 500;
  let socket: WebSocket | null = null;
  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/api/events`);
    socket.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; snapshot?: Snapshot };
      if (msg.type === "snapshot" && msg.snapshot) onSnapshot(msg.snapshot);
    };
    socket.onclose = () => {
      onStatus(false);
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

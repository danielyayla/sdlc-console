import { createHash, timingSafeEqual } from "node:crypto";
import type { HostRepo, WebhookEvent } from "@sdlc/adapter-git";
import { parseProjectPath } from "./remote.js";

/**
 * Inbound GitLab webhooks (3.7). GitLab does not sign deliveries: it sends
 * the secret token configured on the hook as `X-Gitlab-Token`, compared here
 * in constant time. A delivery is then data: the parser reduces the payload
 * to the same routing facts the GitHub receiver produces, so the engine
 * handles one event shape.
 */

/** `X-Gitlab-Token` equals the configured secret (constant-time; lengths differ → false). */
export function verifyWebhookToken(secret: string, given: string | undefined): boolean {
  if (!secret || !given) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(given.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The replay key: `X-Gitlab-Event-UUID` when the instance sends one (GitLab
 * 15.x+), else a hash of the raw body — older instances send no delivery id,
 * and the same payload re-sent is the same delivery.
 */
export function deliveryIdFor(uuid: string | undefined, body: Buffer | string): string {
  const id = uuid?.trim() ?? "";
  if (id !== "") return id;
  return `body-sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export interface GitLabWebhookHeaders {
  /** `X-Gitlab-Event` (e.g. `Merge Request Hook`, `Pipeline Hook`, `Push Hook`). */
  event: string | undefined;
  /** `X-Gitlab-Event-UUID`, when present. */
  uuid: string | undefined;
  /** `X-Gitlab-Token`. */
  token: string | undefined;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown): string | null => (typeof v === "string" && SHA.test(v) ? v : null);
const ZERO = "0".repeat(40);

function repoOf(payload: Obj): HostRepo | null {
  const project = obj(payload["project"]);
  const path = str(project?.["path_with_namespace"]);
  return path ? parseProjectPath(path) : null;
}

/** `Merge Request Hook` → `merge_request`, `Push Hook` → `push`, `Pipeline Hook` → `pipeline`, … (the payload's `object_kind`). */
export function eventKind(eventName: string, payload: unknown): string {
  const fromHeader = eventName.trim().toLowerCase().replace(/\s+hook$/, "").replace(/\s+/g, "_");
  return fromHeader !== "" ? fromHeader : (str(obj(payload)?.["object_kind"]) ?? "");
}

const PIPELINE_STATE: Record<string, string> = { success: "success", failed: "failure", canceled: "error", skipped: "error", manual: "pending" };

/** Reduce a GitLab delivery to its routing facts; malformed payloads come back as `other`, never throw. */
export function parseGitLabWebhook(eventName: string, payload: unknown): WebhookEvent {
  const p = obj(payload) ?? {};
  const repo = repoOf(p);
  const kind = eventKind(eventName, payload);
  const attrs = obj(p["object_attributes"]);
  switch (kind) {
    case "merge_request": {
      const number = num(attrs?.["iid"]);
      const headRef = str(attrs?.["source_branch"]);
      const baseRef = str(attrs?.["target_branch"]);
      const headSha = sha(obj(attrs?.["last_commit"])?.["id"]);
      const action = str(attrs?.["action"]);
      if (!attrs || number === null || !headRef || !baseRef || !headSha || !action) return { kind: "other", event: kind, action, repo };
      const user = str(obj(p["user"])?.["username"]);
      if (action === "approved" || action === "unapproved" || action === "approval" || action === "unapproval") {
        return { kind: "pull_request_review", action: "submitted", repo, number, state: action.startsWith("un") ? "dismissed" : "approved", author: user, headSha };
      }
      const state = str(attrs["state"]);
      const merged = action === "merge" || state === "merged";
      const mapped = merged ? "closed" : action === "open" ? "opened" : action === "reopen" ? "reopened" : action === "close" ? "closed" : action === "update" ? (str(attrs["oldrev"]) ? "synchronize" : "edited") : action;
      return { kind: "pull_request", action: mapped, repo, number, headRef, headSha, baseRef, merged, mergeSha: merged ? sha(attrs["merge_commit_sha"]) : null, mergedBy: merged ? user : null, state: merged || state === "closed" ? "closed" : "open" };
    }
    case "pipeline": {
      const s = sha(attrs?.["sha"]);
      const status = str(attrs?.["status"]);
      if (!attrs || !s || !status) return { kind: "other", event: kind, action: null, repo };
      return { kind: "status", repo, sha: s, context: "pipeline", state: PIPELINE_STATE[status] ?? "pending" };
    }
    case "push": {
      const ref = str(p["ref"]);
      const before = sha(p["before"]);
      const after = sha(p["after"]);
      if (!ref || !before || !after) return { kind: "other", event: kind, action: null, repo };
      return { kind: "push", repo, ref, before, after, deleted: after === ZERO, forced: false };
    }
    default:
      return { kind: "other", event: kind, action: str(attrs?.["action"]), repo };
  }
}

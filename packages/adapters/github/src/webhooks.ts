import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "@sdlc/adapter-git";
import type { GitHubRepo } from "./remote.js";

export { sameRepo, type WebhookEvent } from "@sdlc/adapter-git";

/**
 * Inbound webhooks (blueprint §9.5, build-order 2.4). A delivery is verified
 * by its HMAC signature and then treated as data: the parser reduces the
 * payload to the few routing facts the engine needs (which PR, which head,
 * which branch), and the engine re-derives everything from git after
 * fetching. Nothing in a payload is an instruction.
 */

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body with the shared secret. Constant-time. */
export function verifyWebhookSignature(secret: string, body: Buffer | string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m?.[1]) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(m[1], "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface WebhookHeaders {
  /** `X-GitHub-Event` */
  event: string | undefined;
  /** `X-GitHub-Delivery` — unique per delivery; a redelivery reuses it. */
  delivery: string | undefined;
  /** `X-Hub-Signature-256` */
  signature: string | undefined;
}

// `WebhookEvent` is the shared shape in @sdlc/adapter-git (both hosts reduce to it); re-exported above.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown): string | null => (typeof v === "string" && SHA.test(v) ? v : null);

function repoOf(payload: Obj): GitHubRepo | null {
  const repository = obj(payload["repository"]);
  const name = str(repository?.["name"]);
  const owner = str(obj(repository?.["owner"])?.["login"]);
  return name && owner ? { owner, repo: name } : null;
}

/** Reduce a GitHub delivery to its routing facts; malformed payloads come back as `other`, never throw. */
export function parseWebhook(eventName: string, payload: unknown): WebhookEvent {
  const p = obj(payload) ?? {};
  const repo = repoOf(p);
  const action = str(p["action"]);
  switch (eventName) {
    case "ping":
      return { kind: "ping", repo, zen: str(p["zen"]) };
    case "pull_request": {
      const pr = obj(p["pull_request"]);
      const number = num(pr?.["number"]) ?? num(p["number"]);
      const head = obj(pr?.["head"]);
      const headSha = sha(head?.["sha"]);
      const headRef = str(head?.["ref"]);
      const baseRef = str(obj(pr?.["base"])?.["ref"]);
      if (!pr || !action || number === null || !headSha || !headRef || !baseRef) return { kind: "other", event: eventName, action, repo };
      const merged = pr["merged"] === true;
      return { kind: "pull_request", action, repo, number, headRef, headSha, baseRef, merged, mergeSha: merged ? sha(pr["merge_commit_sha"]) : null, mergedBy: str(obj(pr["merged_by"])?.["login"]), state: str(pr["state"]) === "closed" ? "closed" : "open" };
    }
    case "pull_request_review": {
      const pr = obj(p["pull_request"]);
      const review = obj(p["review"]);
      const number = num(pr?.["number"]);
      if (!pr || !review || !action || number === null) return { kind: "other", event: eventName, action, repo };
      return { kind: "pull_request_review", action, repo, number, state: str(review["state"]) ?? "unknown", author: str(obj(review["user"])?.["login"]), headSha: sha(obj(pr["head"])?.["sha"]) };
    }
    case "check_run": {
      const run = obj(p["check_run"]);
      const headSha = sha(run?.["head_sha"]);
      const name = str(run?.["name"]);
      if (!run || !action || !headSha || !name) return { kind: "other", event: eventName, action, repo };
      return { kind: "check_run", action, repo, name, status: str(run["status"]) ?? "unknown", conclusion: str(run["conclusion"]), headSha };
    }
    case "status": {
      const s = sha(p["sha"]);
      const context = str(p["context"]);
      const state = str(p["state"]);
      if (!s || !context || !state) return { kind: "other", event: eventName, action, repo };
      return { kind: "status", repo, sha: s, context, state };
    }
    case "push": {
      const ref = str(p["ref"]);
      const before = sha(p["before"]);
      const after = sha(p["after"]);
      if (!ref || !before || !after) return { kind: "other", event: eventName, action, repo };
      return { kind: "push", repo, ref, before, after, deleted: p["deleted"] === true, forced: p["forced"] === true };
    }
    default:
      return { kind: "other", event: eventName, action, repo };
  }
}

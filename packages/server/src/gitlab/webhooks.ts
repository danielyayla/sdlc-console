import { sameRepo } from "@sdlc/adapter-git";
import { deliveryIdFor, parseGitLabWebhook, verifyWebhookToken, type GitLabWebhookHeaders } from "@sdlc/adapter-gitlab";
import { hostedCodeHostFrom } from "../engine/codehost.js";
import type { Delivery, ReceiverDeps, ReceivedWebhook } from "../github/webhooks.js";

const MAX_BODY = 1024 * 1024;

/**
 * `POST /api/webhooks/gitlab` (3.7), the GitHub receiver's discipline with
 * GitLab's wire format: secret configured (`SDLC_GITLAB_WEBHOOK_SECRET`) →
 * `X-Gitlab-Token` equals it (constant-time) → event header present → replay
 * (by `X-Gitlab-Event-UUID`, or a hash of the body on instances that send
 * none) → JSON → the delivery names this clone's project → the engine, on
 * the same event shape the GitHub receiver produces. A failed dispatch
 * answers 500 and is not recorded, so GitLab's retry reprocesses it.
 */
export async function receiveGitLabWebhook(deps: ReceiverDeps, input: { headers: GitLabWebhookHeaders; body: Buffer }): Promise<ReceivedWebhook> {
  const secret = deps.env["SDLC_GITLAB_WEBHOOK_SECRET"];
  if (!secret) return { status: 503, body: { error: "GitLab webhook receiver is off: set SDLC_GITLAB_WEBHOOK_SECRET in the environment of sdlc serve" } };
  if (input.body.length > MAX_BODY) return { status: 413, body: { error: "payload too large" } };
  if (!verifyWebhookToken(secret, input.headers.token)) return { status: 401, body: { error: "X-Gitlab-Token missing or invalid" } };
  const eventName = input.headers.event?.trim() ?? "";
  if (eventName === "") return { status: 400, body: { error: "X-Gitlab-Event is required" } };
  if (!deps.engine || !deps.deliveries) return { status: 503, body: { error: "webhooks need the engine (start the server with sdlcBin)" } };
  const id = deliveryIdFor(input.headers.uuid, input.body);
  const prior = deps.deliveries.get(id);
  if (prior) return { status: 200, body: { ok: true, replay: true, delivery: prior } };
  let payload: unknown;
  try {
    payload = JSON.parse(input.body.toString("utf8"));
  } catch (e) {
    return { status: 400, body: { error: `invalid JSON body: ${(e as Error).message}` } };
  }
  const event = parseGitLabWebhook(eventName, payload);
  const action = "action" in event ? event.action : null;
  const receivedAt = (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const repo = deps.store.currentRepo ?? (await deps.store.refresh(), deps.store.currentRepo);
  let status = 200;
  let outcome: string;
  let changeId: string | null = null;
  if (!repo || repo.config.codeHost !== "gitlab") {
    status = 202;
    outcome = "ignored: config.codeHost is not gitlab";
  } else {
    const host = hostedCodeHostFrom("gitlab", deps.env);
    const ours = host ? await host.repoFor(deps.store.root).catch(() => null) : null;
    if (!host) {
      status = 202;
      outcome = "ignored: GITLAB_TOKEN is not set, so the project cannot be confirmed";
    } else if (!sameRepo(ours, event.repo)) {
      status = 202;
      outcome = `ignored: delivery is for ${event.repo ? `${event.repo.owner}/${event.repo.repo}` : "an unnamed project"}, this clone is ${ours ? `${ours.owner}/${ours.repo}` : "not a GitLab remote"}`;
    } else {
      try {
        const r = await deps.engine.onWebhook(event);
        outcome = r.outcome;
        changeId = r.changeId;
      } catch (e) {
        deps.log?.(`[webhook] ${id} ${eventName}${action ? `.${action}` : ""}: ${(e as Error).message}`);
        return { status: 500, body: { error: (e as Error).message, delivery: id } };
      }
    }
  }
  const delivery: Delivery = { id, event: eventName, action, receivedAt, status, outcome, changeId };
  deps.deliveries.record(delivery);
  deps.log?.(`[webhook] ${eventName}${action ? `.${action}` : ""} ${id}: ${outcome}`);
  return { status, body: { ok: true, replay: false, delivery } };
}

---
id: CHG-0021
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "sdlc serve exposes POST /api/webhooks/github; a delivery is accepted only with a valid X-Hub-Signature-256 under GITHUB_WEBHOOK_SECRET and is treated as data; a PR merged on GitHub delivered as pull_request.closed records the gate decision under the mapped identity and the change derives stage 6; a replayed delivery id is a no-op and a re-sent event finds every downstream job key already claimed; pull_request.synchronize on the code PR fetches the new head and runs the per-change run on it, recording pr.synchronized and the new head/checks on pr.yaml so the stale review is relaunched; push to the default branch brings origin in; polling stays on as the fallback and backs off while deliveries arrive; build/test/lint green"
schema: 1
---
# Plan: Webhooks with polling fallback (2.4) (from spec.md n/a)

## Files that change
packages/schemas/src/event.ts
packages/schemas/json/event.schema.json (generated)
packages/core/src/derive.ts
packages/core/src/activity.ts
packages/adapters/git/src/codehost.ts
packages/adapters/github/src/webhooks.ts (new)
packages/adapters/github/src/codehost.ts
packages/adapters/github/src/index.ts
packages/adapters/github/test/webhooks.test.ts (new)
packages/server/src/engine/runner.ts
packages/server/src/engine/engine.ts
packages/server/src/engine/jobs.ts
packages/server/src/github/webhooks.ts (new)
packages/server/src/github/index.ts
packages/server/src/http.ts
packages/server/src/serve.ts
packages/server/test/webhooks.test.ts (new)
packages/cli/src/commands/serve.ts
packages/cli/src/main.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Schemas: new event `pr.synchronized {number?, headSha}` (system actor) — the code PR's head moved and a run tested it. Regenerate JSON.
2. Core: the findings cut-off and the gate-5 "since" use the latest of `pr.opened` (code) / `pr.synchronized`; activity text.
3. adapter-git: `CodeHost.syncPr(input, existing)` — same input as `openPr`, records the new head and the run's checks on `pr.yaml` (tally/review of the old head dropped) plus the event; `LocalCodeHost` implements it (a manual `sdlc run` after new commits refreshes the local PR instead of re-opening it).
4. adapter-github: `webhooks.ts` — `verifyWebhookSignature` (HMAC-SHA256, constant-time) and `parseWebhook` (ping, pull_request, pull_request_review, check_run, status, push → one small typed shape; everything else `other`). `GitHubCodeHost.syncPr` pushes, confirms the open PR's head is the tested head, publishes `sdlc/<check>` statuses on it.
5. Server runner: a green run whose change already has an unmerged PR on this branch calls `syncPr` when the head moved, nothing when it did not. Engine: `onWebhook(event)` dispatch (merged → sync → gate recorded; opened/reopened/review → sync; synchronize on the code PR → `runForPrHead`; push to the default branch → sync; push/synchronize on an `sdlc/<CHG>/<artifact>` branch → fetch + refresh; check_run/status → noted), `runForPrHead` (fetch, fast-forward the branch worktree, run), delivery timestamps and the poll back-off. `DeliveryLog` (SQLite, disposable) keyed by `X-GitHub-Delivery`. `receiveWebhook` = secret check → signature → replay → repo match → dispatch → record. HTTP: `POST /api/webhooks/github` (raw body, 1 MB cap), `GET /api/webhooks` (status + recent deliveries).
6. CLI: `sdlc serve --host <addr>`; usage names the receiver and its env var.
7. Tests: adapter (signature, parse); server GitHub-mode (503/401/replay/ignored; merged-on-GitHub delivery → stage 6 and idempotent on re-send; synchronize → run on the new head, `pr.synchronized`, statuses, findings cut-off; push to main → local main takes origin; poll back-off).
8. decisions.md rows; tick 2.4.

## Risks
- A delivery is data: nothing in the payload is trusted beyond routing — the engine re-derives from git after fetching; the merger identity comes from the API (`getPull`), not the payload.
- `sdlc serve` binds 127.0.0.1; GitHub reaches the receiver through a tunnel or `--host`. Without `GITHUB_WEBHOOK_SECRET` the route answers 503 and never processes an unsigned body.
- A synchronize whose run is red leaves `pr.yaml` at the old tested head: the merge precondition then fails at GitHub (409, retryable) rather than merging an untested head.
- A build session still running on the PR branch owns the next run; the synchronize delivery is noted and skipped.

## Proof
pnpm build, pnpm test (adapters/github webhooks.test.ts, server webhooks.test.ts, existing suites), pnpm lint.

---
id: CHG-0010
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Against the seed in a temp git repo: GET /api/state returns the derived snapshot with identity and defaultRole; a WebSocket client receives a snapshot on connect and a new revision after POST /api/changes/CHG-0022/accept and after an external git commit; role/precondition failures answer 403/409 with diagnostics; build/test/lint green"
schema: 1
---
# Plan: sdlc serve, build-order item 1.1 (from spec.md n/a)

## Files that change
pnpm-workspace.yaml
tsconfig.json
vitest.config.ts
packages/server/package.json (new)
packages/server/tsconfig.json (new)
packages/server/tsconfig.build.json (new)
packages/server/src/index.ts (new)
packages/server/src/snapshot.ts (new)
packages/server/src/store.ts (new)
packages/server/src/watcher.ts (new)
packages/server/src/actions.ts (new)
packages/server/src/http.ts (new)
packages/server/src/serve.ts (new)
packages/server/test/index.test.ts (new)
packages/server/test/serve.test.ts (new)
packages/cli/package.json
packages/cli/tsconfig.build.json
packages/cli/src/commands/serve.ts (new)
packages/cli/src/main.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Scaffold `@sdlc/server` (deps: core, schemas, adapter-git, ws).
2. snapshot.ts: `buildSnapshot(repo, identity, sessions, revision)` — changes, queues and badges per role, triage/findings/proposals/evals, parsed config (CLAUDE.md, hooks, skills, agents, bands), validation report, identity + defaultRole.
3. store.ts: `StateStore` reads the tree at HEAD through the git adapter, derives, bumps `revision`, notifies subscribers; `act(fn)` runs a transition → validateWritePlan → commitWritePlan → refresh, mapping refusals to 403/409 and git failures to 502.
4. watcher.ts: fs.watch (recursive) on `.git/HEAD`, `.git/refs`, `sdlc`, `evals`, `.claude`, `CLAUDE.md`, `bands.yaml`, debounced → refresh.
5. http.ts: node:http router — GET /api/state, GET /api/changes/:id, GET /api/changes/:id/artifacts/:index, POST /api/changes, POST /api/changes/:id/accept|send-back|loop|tasks/confirm|repro/confirm, POST /api/triage/:id/accept|dismiss, POST /api/findings/:id/patch|escalate|dismiss; responses carry `{snapshot, toast}`; WebSocket `/api/events` broadcasts `{type:"snapshot"}` with the revision.
6. serve.ts: `startServer({root, port, identity, defaultRole})` → {url, close}; CLI `sdlc serve --port --role`.
7. Tests over the seed in a temp repo with fetch + ws client.

## Risks
- fs.watch recursive coalesces events differently per platform; the debounce plus a HEAD-sha check makes refreshes idempotent.
- Full snapshots are broadcast on every change (no incremental patches yet); acceptable at seed scale, recorded as a decision.

## Proof
pnpm build, pnpm test (packages/server/test/serve.test.ts), pnpm lint; `node packages/cli/dist/bin.js serve --port 0` prints a URL.

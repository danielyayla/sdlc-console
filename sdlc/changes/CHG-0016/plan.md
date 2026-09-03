---
id: CHG-0016
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "In a seeded temp repo with a fake harness and fake verification commands: a finished build session triggers a per-change run that writes evals/run-<n>.json on the default branch; green opens a local PR (pr.yaml, pr.opened, stage.entered 5) and the change derives to stage 5; red keeps stage 4 and resumes the session once, twice → waiting on you; gate 5 accept merges the task branch → stage 6; loop → cycle 2 stage 1; every transition job is idempotent by key; build/test/lint green"
schema: 1
---
# Plan: Lifecycle engine, local mode (1.7) (from spec.md n/a)

## Files that change
packages/server/src/engine/codehost.ts (new)
packages/server/src/engine/runner.ts (new)
packages/server/src/engine/jobs.ts (new)
packages/server/src/engine/engine.ts (new)
packages/server/src/engine/index.ts (new)
packages/server/src/index.ts
packages/server/src/http.ts
packages/server/src/serve.ts
packages/server/src/sessions/registry.ts
packages/server/test/engine.test.ts (new)
packages/cli/src/commands/run.ts (new)
packages/cli/src/commands/serve.ts
packages/cli/src/main.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. codehost.ts: `CodeHost` interface (`openPr`, `mergeState`); `LocalCodeHost` records `pr.yaml {provider: local}` and merges via git; `GitHubCodeHost` is an interface stub that refuses without a token (Phase 2 / needs credentials).
2. runner.ts: per-change run over a task worktree — verification commands from CLAUDE.md + checks of active eval cases whose paths intersect the diff — writes `evals/run-<n>.json` (configRef from the worktree tree) and `evals.green|red` on the default branch as `sdlc-bot`; `exec` seam for tests.
3. jobs.ts: SQLite `jobs` table with idempotency keys `<change>:<cycle>:<stage>:<artifactSha>`, states queued/running/done/failed.
4. engine.ts: reacts to store refreshes and session exits — stage 2 → design session; stage 3 → plan session; stage 4 after gate 3 → tasks confirmed (auto-proposal) + build session (AUTO or SUPERVISED); session done → per-change run; green → PR + stage 5; red → resume once with failing output, second red → waiting; `stage.entered` for engine-driven transitions. Every action is a job with a key; failures are recorded, never retried in a loop.
5. HTTP: `POST /api/changes/:id/run` (manual per-change run), `GET /api/jobs`; `sdlc serve --engine`; CLI `sdlc run <CHG>`.
6. Tests with fake harness + fake exec; decisions; tick 1.7.

## Risks
- The engine launches real headless sessions when enabled; it is opt-in (`--engine`) and every launch is a keyed job so a replayed refresh cannot double-launch.
- GitHub mode needs a token: not implemented beyond the interface; local mode is complete.

## Proof
pnpm build, pnpm test (engine.test.ts), pnpm lint.

---
id: CHG-0009
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "fixtures/seed reproduces the spec seed (8 changes across all six stages, 2 triage, 3 findings, 4 sessions); golden tests (a)–(f) pass over it in memory and sdlc validate/audit are clean over it in a real git repo; build/test/lint green"
schema: 1
---
# Plan: Fixture repo and golden tests, build-order item 0.9 (from spec.md n/a)

## Files that change
pnpm-workspace.yaml
tsconfig.json
vitest.config.ts
eslint.config.js
packages/core/src/writeplan.ts
packages/core/src/validate/engine.ts
packages/core/src/transitions/triage.ts (new)
packages/core/src/transitions/finding.ts (new)
packages/core/src/transitions/index.ts
packages/core/test/transitions.test.ts
fixtures/package.json (new)
fixtures/tsconfig.json (new)
fixtures/tsconfig.build.json (new)
fixtures/src/index.ts (new)
fixtures/src/seed.ts (new)
fixtures/scripts/generate.mjs (new)
fixtures/sessions.seed.json (new)
fixtures/seed/** (new, generated)
fixtures/test/seed-sync.test.ts (new)
fixtures/test/acceptance.test.ts (new)
fixtures/test/git.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. core: `acceptTriage`, `dismissTriage`, `escalateFinding`, `patchFinding`, `dismissFinding` as write-plans; `WritePlan.changeId` may be null for plans that touch no change.
2. `@sdlc/fixtures` at `fixtures/` (workspace member): `seedFiles()` builds every file of the seed repo with git-compatible blob shas so SHA chaining is real; `seedTree()`; `writeSeed(dir)`; `seedSessions()` from sessions.seed.json.
3. Seed: CHG-0022/0023 (Plan), 0021 (Design), 0019 high-risk + 0020 routine (Build), 0018 fix with committed repro and a red run (Test), 0017 green run + open PR (Deploy), 0012 merged + incident (Maintain); TRI-0042/0043; SEC-0118/0119/0120; PRP-0007; CASE-0001/0002 active, 0003 draft; RUN-0001; config, CLAUDE.md, settings hooks, skill, agent, bands, REVIEW.md.
4. `fixtures/seed/` committed = generator output (sync test).
5. Golden tests (a)–(f) plus (g), (h), (k), (l) over `seedTree()` through core; real-git test runs the CLI over the seed.
6. Decisions, tick 0.9.

## Risks
- Fixture shas are computed from content, so editing a seed file by hand breaks chaining — the sync test makes the generator the only editing path.

## Proof
pnpm build, pnpm test (fixtures/test/*), pnpm lint; `node fixtures/scripts/generate.mjs && git diff --exit-code fixtures/seed`.

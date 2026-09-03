---
id: CHG-0004
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "deriveChange() yields the right stage/gate/since/agent/status/docs/planState/autoEligible for synthetic trees at every stage 1–6, send-back, high-risk, red evals and loop; core stays free of Node imports; build/test/lint green"
schema: 1
---
# Plan: Core derivation, build-order item 0.4 (from spec.md n/a)

## Files that change
packages/schemas/package.json
packages/schemas/src/glob.ts (new)
packages/schemas/src/index.ts
packages/core/package.json
packages/core/tsconfig.build.json
packages/core/src/index.ts
packages/core/src/tree.ts (new)
packages/core/src/stages.ts (new)
packages/core/src/config.ts (new)
packages/core/src/fingerprint.ts (new)
packages/core/src/repo.ts (new)
packages/core/src/events.ts (new)
packages/core/src/activity.ts (new)
packages/core/src/eligibility.ts (new)
packages/core/src/derive.ts (new)
packages/core/src/queues.ts (new)
packages/core/test/helpers.ts (new)
packages/core/test/index.test.ts
packages/core/test/derive.test.ts (new)
packages/core/test/repo.test.ts (new)
packages/core/test/queues.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. schemas: `compileGlobs`/`matchesAnyGlob` over picomatch so core never imports a matcher itself.
2. tree.ts: `Tree {ref, files: Map<path, {content, sha}>}`, `treeFromRecord` (synthetic 40-hex sha), `filesUnder`, `childDirs`.
3. stages.ts: STAGES table, `gateDefs`, `gateOwner(gate, risk)`, role labels.
4. config.ts: `resolveConfig` applying CONFIG_DEFAULTS; fingerprint.ts: `configFingerprint(tree)` and `fingerprintMatches`.
5. repo.ts: `loadRepo(tree)` parses config, CLAUDE.md, settings, skills, agents, bands, every change directory, triage, findings, proposals, eval cases/runs; diagnostics carried, never thrown.
6. events.ts: per-cycle event ordering, last-of helpers; activity.ts: event → feed line.
7. derive.ts: `deriveStage`, gate open/since via latest-event-wins, docs states incl. stale, planRev/planState/planMatches, evals state, status text, validation inconsistencies → `ChangeView`; `deriveAll`.
8. eligibility.ts: the five FR-34 terms with details; strict/lenient coverage (Q9).
9. queues.ts: gate queues by role (since desc), pipeline columns, badges.
10. Tests: helper builds synthetic change trees stage by stage; golden expectations per stage, send-back, high-risk gate 3, red/waiting evals, stale artifact, fingerprint mismatch, invalid change excluded from queues.
11. Decisions, tick 0.4, commit.

## Risks
- Gate 3 "final draft" semantics rely on event order (latest of committed/final/drafted/sent_back wins); documented in decisions.
- Model pin is not in the tree, so fingerprint matching ignores it and records it only.

## Proof
pnpm build, pnpm test (core derive/repo/queues), pnpm lint (core builtin ban still in force).

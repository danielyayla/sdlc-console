---
id: CHG-0006
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "validateTree over synthetic trees reports each §11.1 adapter-free rule with blocking=true, a clean tree reports nothing blocking, an agent-authored gate.accepted is rejected, and the three hook checks (planSync, testFreeze, verifyBeforeDone) block/allow as specified; build/test/lint green"
schema: 1
---
# Plan: Validation engine, build-order item 0.6 (from spec.md n/a)

## Files that change
packages/core/src/index.ts
packages/core/src/derive.ts
packages/core/src/transitions/context.ts
packages/core/src/transitions/create-change.ts
packages/core/src/transitions/loop.ts
packages/core/src/transitions/accept.ts
packages/core/src/validate/rules.ts (new)
packages/core/src/validate/engine.ts (new)
packages/core/src/validate/checks.ts (new)
packages/core/src/validate/index.ts (new)
packages/core/test/validate.test.ts (new)
packages/core/test/checks.test.ts (new)
packages/core/test/derive.test.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. context: optional `blobSha(content)` so `artifact.committed` events carry the real blob sha (adapter supplies git's; synthetic by default).
2. derive: `incCaseBlocked` keeps a looped change at stage 4 until its `INC-<id>-<n>` case is `active` (FR-14/FR-53); status says which case to activate.
3. rules.ts: per-change rules — schema/parse errors, artifact completeness when its gate is open, SHA chaining (spec.intent_sha ↔ gate 1 artifactSha, plan.spec_sha ↔ gate 2), gate actor holds owning role (per config), linked-mode record present once past the artifact's stage, tasks (disjoint non-sequential file sets, target before running), repro state consistent; repo rules — active eval case has ≥1 check, dismissed triage/finding/proposal carries a reason, hook lint and CLAUDE.md warnings passed through.
4. engine.ts: `validateTree(repo)` → {diagnostics (blocking flag), blocking}; `validateChange`; `validateDiff(before, after)` for risk/kind immutability at stage ≥3 and archived-cycle tampering; `validateIds(idsByRef)` for duplicates across branches; `validateWritePlan(repo, plan)` applies the plan to the tree and validates the result plus every event.
5. checks.ts: `planSync(diffFiles, planFiles, planPathInDiff)`, `testFreeze(path, view, testGlobs)`, `verifyBeforeDone(rounds)` — pure, return {allowed, reason}.
6. accept refuses when the gate's artifact is incomplete.
7. Tests for every rule with positive and negative trees; decisions; tick 0.6.

## Risks
- Chaining compares blob shas; synthetic shas in tests stand in for git's, so the rule is exercised structurally, and 0.9 fixtures re-check it with real git shas.

## Proof
pnpm build, pnpm test (validate.test.ts, checks.test.ts), pnpm lint.

---
id: CHG-0024
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "For a fix change at stage 4 the build session reports the failing test through mcp__sdlc__report_repro, which commits the test alone on the task branch and keeps the draft (path, reason, sha, verbatim output) beside the session; the console shows the repro card with 'Fails for the right reason → commit' and 'Wrong failure — send back' for the engineer only; confirm verifies the commit touches only the test, writes change.yaml repro committed + evals/repro.json verbatim + repro.confirmed, and resumes the session under the freeze; reject records repro.rejected and resumes the session with the reason; the engine runs no per-change run while a repro awaits confirmation; freeze lift is one freeze.lifted per path per change (second refused, a duplicate is a blocking validation error) honoured by the test-freeze hook from the default-branch ledger; the per-change run puts a 'repro' check on the PR (committed <sha> before fix · unchanged in diff · passing) and, when managed hooks are not installed, a test-freeze auto-finding per test file changed after the repro commit without a lift; gate 5 in the console refuses while an auto-finding is undismissed or the repro check fails, dismissal needs a reason and is logged; CLI repro confirm|reject and freeze lift|dismiss exist; build/test/lint green"
schema: 1
---
# Plan: Repro-first fix flow end-to-end (2.7) (from spec.md n/a)

## Files that change
packages/schemas/src/event.ts
packages/schemas/src/pr.ts
packages/schemas/json/*.schema.json
packages/core/src/transitions/repro.ts
packages/core/src/transitions/accept.ts
packages/core/src/derive.ts
packages/core/src/activity.ts
packages/core/src/validate/rules.ts
packages/core/test/transitions.test.ts
packages/core/test/repro-flow.test.ts (new)
packages/hooks/src/context.ts
packages/hooks/test/hooks.test.ts
packages/mcp/src/sessions.ts
packages/mcp/src/tools.ts
packages/mcp/src/context-bundle.ts
packages/mcp/test/tools.test.ts
packages/adapters/git/src/codehost.ts
packages/adapters/github/src/codehost.ts
packages/server/src/actions.ts
packages/server/src/http.ts
packages/server/src/sessions/registry.ts
packages/server/src/sessions/prompts.ts
packages/server/src/sessions/repro.ts (new)
packages/server/src/sessions/index.ts
packages/server/src/engine/engine.ts
packages/server/src/engine/runner.ts
packages/server/test/repro.test.ts (new)
packages/cli/src/commands/repro.ts (new)
packages/cli/src/main.ts
packages/cli/test/cli.test.ts
packages/web/src/views/ChangeDetail.tsx
packages/web/src/app.tsx
packages/web/test/render.test.tsx
docs/decisions.md
docs/build-order.md

## Order of work
1. Schemas: `repro.rejected{testPath, reason}` (human); `pr.yaml` checks carry an optional `summary`; `pr.yaml.autoFindings[{rule, path, title, detail, dismissal?}]`.
2. Core: `rejectRepro`, `liftFreeze` (once per path per cycle), `dismissAutoFinding` (reason, logged as a note); gate 5 refuses `merge.auto-finding` / `merge.repro-red` for console/CLI decisions (a merge already done on the code host is recorded as truth); `ChangeView.freezeLifts` and `reproRejection`; rule `freeze.lifted-twice`; activity lines.
3. Agent side: `report_repro` commits the test alone (verified with diff-tree), appends `repro.failed`, writes the draft beside the session; stage-4 tool list includes it; the build prompt says repro first, then stop.
4. Hooks: the worktree hook context merges the default-branch ledger so a lift recorded in the console reaches the freeze check.
5. Server: draft in the session record with "waiting on you: confirm the repro test"; confirm verifies the commit, commits, clears the draft, resumes the session under the freeze; reject records, marks the draft, resumes with the reason; engine skips the per-change run while a draft awaits; runner computes the repro check, the test-freeze auto-findings (fallback only) and carries dismissals across a head move; routes `repro/reject`, `freeze/lift`, `auto-findings/dismiss`.
6. CLI `sdlc repro confirm|reject <CHG>`, `sdlc freeze lift|dismiss <CHG> --file --reason`.
7. Web: repro card (drafted / rejected / committed + lifts), PR panel check summaries and auto-findings with Dismiss; app wiring.
8. Tests, decisions, build-order tick.

## Risks
- The repro commit is on the task branch; the console verifies it by sha through the shared object store, never by trusting the draft.
- Ledger seq collisions between the task branch and the default branch are already accepted (2.3); union merge keeps both.
- A harness without hooks relies on the fallback finding; it blocks the console's merge only — a team that merges on GitHub makes `sdlc/test-freeze` required there.

## Proof
- core: transitions and gate-5 refusals; validation of a double lift.
- mcp: `report_repro` commits the test alone, refuses non-fix / committed / dirty commits.
- hooks: lift on main honoured in the worktree.
- server: full local flow on a fix change — report → hold → reject → report → confirm → fix with a stray test edit and no hooks → PR with repro pass + auto-finding → merge refused → dismiss → merge; lift twice refused; repro test modified → repro fail → merge refused.
- web: CHG-0018 detail shows the committed repro and the lift button.

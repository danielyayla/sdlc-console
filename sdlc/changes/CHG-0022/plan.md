---
id: CHG-0022
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "sdlc evals run executes every active case's checks in a detached worktree and commits evals/runs/RUN-NNNN.json (trigger, config fingerprint, results verbatim, pass rate, threshold, verdict pass|fail|incomplete, cost) as sdlc-bot; verdict is pass only when the pass rate meets the threshold and every active case ran, incomplete never counts; sdlc evals gate exits non-zero for a config change whose run is below threshold and lists regressed cases with before/after output, and reports 'not gated' in scheduled mode; sdlc init generates the evals and validate workflows; Config shows the suite banner with a real Run suite, the 30-run strip with config diffs on hover and the rolling budget; Add as eval on a merged change drafts CASE-NNNN for the platform owner; a case passing noDiscriminationRuns runs in a row raises an eval-retire triage item, a case failing brokenCheckRuns runs under one config raises a flaky one, each once; build/test/lint green"
schema: 1
---
# Plan: Eval suite in CI (2.5) (from spec.md n/a)

## Files that change
packages/core/src/evals.ts (new)
packages/core/src/transitions/evals.ts (new)
packages/core/src/transitions/index.ts
packages/core/src/ids.ts
packages/core/src/derive.ts
packages/core/src/validate/rules.ts
packages/core/src/index.ts
packages/core/test/evals.test.ts (new)
packages/server/src/engine/suite.ts (new)
packages/server/src/engine/engine.ts
packages/server/src/engine/jobs.ts
packages/server/src/engine/index.ts
packages/server/src/actions.ts
packages/server/src/http.ts
packages/server/src/snapshot.ts
packages/server/test/suite.test.ts (new)
packages/cli/src/commands/evals.ts (new)
packages/cli/src/commands/init.ts
packages/cli/src/workflows.ts (new)
packages/cli/src/main.ts
packages/cli/test/cli.test.ts
packages/web/src/views/Config.tsx
packages/web/src/views/ChangeDetail.tsx
packages/web/src/app.tsx
packages/web/src/tokens.css
docs/decisions.md
docs/build-order.md

## Order of work
1. Core (pure): `suiteVerdict` (pass ⇔ rate ≥ threshold ∧ complete; incomplete otherwise never pass), `buildEvalRun`, `nextRunId`/`nextCaseId`, `regressions` (pass→fail with before/after output) and `configChanges` between two runs, `evalGate` (latest run under the current fingerprint; scheduled mode = not gated), `budgetStatus` (rolling 30-day cost vs `evals.budget`), `suiteStatus` for the snapshot, `evalSignals` (retire: N consecutive passes; broken: M consecutive fails under one config), transitions `raiseEvalSignals` (triage items, system actor, deduped by `src`) and `harvestCase` (draft case from a merged change: title + acceptance line, verification commands as checks, plan files as paths, platform owner). `ChangeView.harvested`. Validation: a run marked pass below its threshold blocks.
2. Server: `runSuite` — detached worktree at the ref, every active case's checks through `Exec`, elapsed minutes as cost, stop at the budget → incomplete, commit the run file as sdlc-bot, then raise signals. Engine job `evals-run` (background for the console). Actions/HTTP: `POST /api/evals/run`, `GET /api/evals`, `POST /api/changes/:id/harvest`; snapshot `evals`.
3. CLI: `sdlc evals run [--trigger schedule|config-pr|manual] [--ref]`, `sdlc evals gate [--run id]` (exit 1 below threshold, regressed cases listed), `sdlc evals harvest <CHG>`; `sdlc init` writes `.github/workflows/sdlc-evals.yml` (config-change gate + schedule + dispatch) and `sdlc-validate.yml`, create-only.
4. Web: Config banner from `snapshot.evals` (suite, pass vs threshold, mode with the scheduled amber note, budget used/limit, Run suite real), strip hover with config diff, case table unchanged; Change detail "Add as eval" at stage 6 with the harvested chip.
5. Tests: core rules; server run/incomplete/skip/signals/HTTP; CLI init workflows and the config-change gate golden (acceptance m); web render.
6. decisions.md rows; tick 2.5.

## Risks
- Cost has no currency for shell checks: the runner records elapsed minutes and the budget is read in the same unit; a team wiring a paid runner records its own cost in the same field.
- The scheduled workflow cannot push to a protected default branch: it pushes run files to `sdlc/evals-runs` and opens one long-lived PR, the same shape as the console's records PR.
- Signals are raised by whoever runs the suite (engine or CLI); a triage item is never raised twice for one streak because dedupe keys on `src` and the run window.

## Proof
pnpm build, pnpm test (core evals.test.ts, server suite.test.ts, cli init/evals), pnpm lint.

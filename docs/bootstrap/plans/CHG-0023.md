---
id: CHG-0023
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "New session is disabled (UI) and refused (server, CLI, engine) while the review backlog — sessions done and awaiting review — is over thresholds.sessionCeiling, and the engine launches the waiting build session on the next tick once the backlog clears; sessionCeiling: null means no ceiling and the header shows counts only; the AUTO eligibility verification term holds only for a runnable loop (single-target commands, a test target, and a visual tool when the plan touches UI paths), lenient coverage needs test globs, and a running AUTO session whose change stopped being eligible shows it on the card; POST /api/sessions/:id/downgrade and sdlc session downgrade record override.mode{AUTO→SUPERVISED} by an engineer on the ledger, end the harness and hand the engineer a resume command, upward overrides are refused and a ledger with one fails validation; a build session's rounds with screenshots render as a visual strip whose click shows the screenshot beside the change's design mock with the reported diff, the mock and screenshots are served read-only, and a plan touching UI paths without a Visual: line warns 'UI work without a visual check'; build/test/lint green"
schema: 1
---
# Plan: Build-stage depth — capacity, eligibility, override, visual rounds (2.6) (from spec.md n/a)

## Files that change
packages/schemas/src/config.ts
packages/core/src/config.ts
packages/core/src/eligibility.ts
packages/core/src/repo.ts
packages/core/src/derive.ts
packages/core/src/transitions/override.ts (new)
packages/core/src/transitions/index.ts
packages/core/src/validate/rules.ts
packages/core/test/derive.test.ts
packages/core/test/transitions.test.ts
packages/core/test/validate.test.ts
packages/server/src/sessions/capacity.ts (new)
packages/server/src/sessions/downgrade.ts (new)
packages/server/src/sessions/index.ts
packages/server/src/sessions/launcher.ts
packages/server/src/sessions/observer.ts
packages/server/src/sessions/prompts.ts
packages/server/src/snapshot.ts
packages/server/src/http.ts
packages/server/src/engine/engine.ts
packages/server/test/sessions.test.ts
packages/server/test/engine.test.ts
packages/mcp/src/context-bundle.ts
packages/cli/src/commands/session.ts
packages/cli/src/main.ts
packages/cli/src/commands/init.ts
packages/cli/test/cli.test.ts
packages/web/src/views/Sessions.tsx
packages/web/src/views/ChangeDetail.tsx
packages/web/src/tokens.css
packages/web/test/render.test.tsx
fixtures/src/seed.ts
fixtures/sessions.seed.json
fixtures/seed/sdlc/changes/CHG-0018/design/export-dialog.svg (new)
fixtures/test/seed-sync.test.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Config: `thresholds.sessionCeiling` accepts `null` (no ceiling); resolved type `number | null`.
2. Capacity (server, pure over the registry list + derived stages): `sessionCapacity` → `{active, backlog, ceiling, over}`; backlog = sessions done and awaiting review (build/review: not yet covered by a green run or mirror; artifact sessions: their gate still open). Snapshot carries `capacity`; launcher, engine and UI read the same value. Engine does not claim a build-session job while over the ceiling, so the next tick after the backlog clears launches it.
3. Eligibility: verification term = block present ∧ single-target commands ∧ test target ∧ (UI paths → visual tool); lenient coverage also needs test globs. `uiPaths(planFiles)` heuristic. `ChangeView.visual {uiPaths, tool, mock, warning}` from `design/` (first image) and the contract; "UI work without a visual check".
4. Override: `overrideMode` transition (engineer, downward only, `override.mode` event, commit `sdlc(<CHG>): session <id> AUTO → SUPERVISED`); validation rule `override.upward` (blocking). Server `downgradeSession`: patch the record to SUPERVISED/awaiting_engineer with a `--resume` command, SIGTERM the harness, commit the event on the default branch; observer keeps the status, launcher records `session.stopped{taken_over}`, engine closes the job as done ("downgraded"). Route `POST /api/sessions/:id/downgrade`, CLI `sdlc session downgrade <id> [--reason]`.
5. Visual: context bundle includes `design/*`; build prompt names the mock and asks for screenshots + diffPct per round; routes `GET /api/changes/:id/design/:file` (bytes from git) and `GET /api/sessions/:id/rounds/:n/screenshot` (the round's screenshotRef, confined to the worktree). Sessions card: visual strip (chip per round with a screenshot, colour by diffPct), click opens screenshot beside mock; live eligibility chip on AUTO cards; "UI work without a visual check" on the card and the New session form; Downgrade button. Change detail: visual line in the Auto mode panel.
6. Seed: CHG-0018 gets `design/export-dialog.svg`; `sess-0018-repro` gets two rounds with screenshots and diffPct. Regenerate `fixtures/seed`.
7. Tests, decisions, build-order tick.

## Risks
- Backlog definition drift between UI and server: fixed by computing it once in the snapshot.
- Killing a harness mid-turn loses its in-flight edit; the worktree keeps everything committed and the resume command continues the same harness session.
- diffPct is reported by the session, not measured by the console; the strip says so.

## Proof
- core: eligibility terms (multi-step command, missing test target, UI paths without a visual tool, lenient without globs), `overrideMode` refusals and event, `override.upward` rule, `ChangeView.visual` from the seed.
- server: ceiling refusal via capacity with `null` = unlimited; engine skips then launches once the backlog clears; downgrade of a running AUTO session (event on main, registry SUPERVISED with resume command, job done); design + screenshot routes (200/404, traversal refused).
- cli: `session downgrade` records the event; `init` config unchanged.
- web: seed renders "review backlog 2", visual strip "round 2 · 3.1%", Downgrade only on running AUTO/HEADLESS cards.

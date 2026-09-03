# Build order (blueprint §16)

Work one numbered item at a time. Each item is a plan-mode session → `plan.md` → implement → green → PR. Mark items done here as they merge.

## Phase 0 — Foundation
- [x] 0.1 Monorepo scaffold: pnpm workspaces, TypeScript strict, Vitest, ESLint, `pnpm build/test/lint` at root; packages `schemas`, `core`, `adapters/git`, `cli` (empty shells that build).
- [x] 0.2 Schemas: `change.yaml`, `log.jsonl` event union, `sdlc/config.yaml`, `tasks.yaml`, eval case/run, triage, finding, proposal; front-matter schemas for intent/spec/plan/incident. Ajv validators + zod-derived types, exported.
- [x] 0.3 Parsers: markdown front-matter + required sections (intent/spec/plan/incident); `plan.md` "Files that change" + acceptance line; `CLAUDE.md` commands / "Verifying your work" block / word count; `SKILL.md` front-matter; `.claude/agents/*.md`; `.claude/settings.json` hooks; `bands.yaml`. Structured diagnostics, never throw.
- [x] 0.4 Core derivation: `Tree` abstraction; `loadRepo(tree)`; `deriveChange(id)` → `ChangeView` (stage, gate, since, agent, status, docs states, planRev/State/Matches, autoEligible); gate queues; badges. Pure.
- [x] 0.5 Transitions as write-plans: `createChange`, `accept`, `sendBack`, `loop` (cycle+1 + archive + INC draft case), `confirmTasks`, `confirmRepro`. Return `{files, events, commitMessage}`; no I/O.
- [x] 0.6 Validation engine: blocking rules from blueprint §11.1 that need no adapters (schema, completeness, SHA chaining, gate ownership + human actor, risk/kind immutability, duplicate ids, active-case-has-checks, linked-mode fields).
- [x] 0.7 Git adapter: read tree at ref, apply write-plan as commit with identity + trailers, diff files, worktree add/remove/list, `log.jsonl` union across branches, install `.gitattributes` merge=union.
- [x] 0.8 CLI: `sdlc init`, `validate`, `change new|list|show`, `accept`, `send-back`, `loop`, `audit`; all with `--json`; refuse mutations when `SDLC_ACTOR_TYPE=agent`.
- [x] 0.9 Fixture repo reproducing the spec seed (8 changes across all stages, 2 triage, 3 findings) + golden tests for acceptance checks (a)–(f) from `docs/source/design-spec.md` §7.

## Phase 1 — Local MVP (needs Phase 0)
- [x] 1.1 `sdlc serve`: watcher, snapshot/patch WebSocket, HTTP actions, local identity + `defaultRole`.
- [x] 1.2 Web: top bar, Pipeline, Change detail, Gates, tokens from spec §6.
- [x] 1.3 Web: Loop (file-backed triage), Security (file-backed + CSV/MD import), Metrics from git + ledger.
- [x] 1.4 Hooks package: `plan-sync`, `test-freeze`, `verify-before-done` → `sdlc hook <name>`; installed by init.
- [x] 1.5 MCP server: `list_work`, `get_change`, `get_context`, `propose_artifact`, `submit_plan_revision`, `report_round`, `report_done`, `request_input`, `log_note`.
- [x] 1.6 Claude Code launcher + session observer; Sessions view.
- [x] 1.7 Lifecycle engine (local): accept → job; session done → local per-change run → green opens PR (minimal GitHub) → stage 5; merge → 6; loop.
- [x] 1.8 Config view read-only + eval case table.
Exit: one change travels 1→6→1 with real files, hooks and a real Claude Code session; `sdlc audit` clean.

## Phase 2 — GitHub mode, evals in CI, build-stage depth (blueprint §16 items 13–19)
- [x] 2.1 GitHub adapter (`packages/adapters/github`): REST client over `fetch` with `GITHUB_TOKEN`; `pr.open/get/merge/requestChanges/comment`, commit statuses (`checks.publish`), `codeowners(path)`, branch-protection check; `GitHubCodeHost` opens the code PR and merges at gate 5 through the API under branch protection; `pr.yaml` mirrors number/url/head/merge SHA.
- [x] 2.2 Artifact PRs as gates in GitHub mode: intent/spec/plan/incident drafts pushed as `sdlc/<CHG>/<artifact>` PRs; accept = merge, send-back = "request changes" review + `gate.sent_back`; high-risk gate 3 tech-lead-via-PR routing (`source: pr.merge`, code owner); ledger sync to origin.
- [x] 2.3 Review findings mirror + check runs: review job findings → `review.finding` events and `pr.yaml.findings`; evidence, severity tally and eval verdict published as statuses; PR panel in Change detail.
- [x] 2.4 Webhooks: signature-verified receiver (PR opened/synchronize/review/merged, check completed, push) with polling fallback; merge detected → stage 6; idempotent job keys on replay.
- [x] 2.5 Eval suite in CI: generated workflows, config-change gate (verdict ≥ threshold, `incomplete` ≠ pass), run history strip, budget, harvest actions, retire/broken-check signals → triage.
- [ ] 2.6 Build-stage depth: capacity ceiling, auto-eligibility with verification term, AUTO→SUPERVISED override, visual rounds strip with mock comparison.
- [ ] 2.7 Repro-first fix flow end-to-end: repro confirm/reject, freeze lift once, fallback auto-finding blocking merge, PR repro proof.
- [ ] 2.8 CLAUDE.md repeat-mistake proposals (accept → PR); skills pass % from trigger-test set; backed-by column.
- [ ] 2.9 Records mode (`external`/`linked`) with MCP write-back and retry.
- [ ] 2.10 Metrics from PR/CI/incident sources; trend chips.
Exit: a change travels 1→6→1 against a GitHub repository with branch protection: every artifact and the code are PRs, gate decisions are merges, evidence is on the PR, `sdlc audit` clean.

## Phase 3 — Hosted/team, Maintain automation, deployment tools, other adapters (items 20–23)

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
- [ ] 1.2 Web: top bar, Pipeline, Change detail, Gates, tokens from spec §6.
- [ ] 1.3 Web: Loop (file-backed triage), Security (file-backed + CSV/MD import), Metrics from git + ledger.
- [ ] 1.4 Hooks package: `plan-sync`, `test-freeze`, `verify-before-done` → `sdlc hook <name>`; installed by init.
- [ ] 1.5 MCP server: `list_work`, `get_change`, `get_context`, `propose_artifact`, `submit_plan_revision`, `report_round`, `report_done`, `request_input`, `log_note`.
- [ ] 1.6 Claude Code launcher + session observer; Sessions view.
- [ ] 1.7 Lifecycle engine (local): accept → job; session done → local per-change run → green opens PR (minimal GitHub) → stage 5; merge → 6; loop.
- [ ] 1.8 Config view read-only + eval case table.
Exit: one change travels 1→6→1 with real files, hooks and a real Claude Code session; `sdlc audit` clean.

## Phase 2 — GitHub mode, evals in CI, build-stage depth (blueprint §16 items 13–19)
## Phase 3 — Hosted/team, Maintain automation, deployment tools, other adapters (items 20–23)

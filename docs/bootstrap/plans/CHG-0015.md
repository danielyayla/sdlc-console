---
id: CHG-0015
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "With a fake `claude` binary: launching a plan session for a seeded change creates the worktree on sdlc/<CHG>/plan, writes the session's mcp.json and prompt, commits session.started, records init/result from stream-json (modelPin, status done), commits session.stopped, and the snapshot lists the session with loop state; launching a build session without a target is refused with 'define done'; AUTO on an ineligible change is refused; the Sessions view renders cards, header counts and the footer callout; build/test/lint green"
schema: 1
---
# Plan: Claude Code launcher + session observer; Sessions view (1.6) (from spec.md n/a)

## Files that change
packages/server/package.json
packages/server/tsconfig.build.json
packages/server/src/index.ts
packages/server/src/snapshot.ts
packages/server/src/store.ts
packages/server/src/http.ts
packages/server/src/serve.ts
packages/server/src/sessions/registry.ts (new)
packages/server/src/sessions/prompts.ts (new)
packages/server/src/sessions/launcher.ts (new)
packages/server/src/sessions/observer.ts (new)
packages/server/src/sessions/index.ts (new)
packages/server/test/fixtures/fake-claude.sh (new)
packages/server/test/sessions.test.ts (new)
packages/server/test/serve.test.ts
packages/cli/src/commands/session.ts (new)
packages/cli/src/commands/serve.ts
packages/cli/src/main.ts
packages/web/src/views/Sessions.tsx (new)
packages/web/src/app.tsx
packages/web/src/tokens.css
packages/web/test/render.test.tsx
docs/decisions.md
docs/build-order.md

## Order of work
1. registry.ts: better-sqlite3 at `.sdlc-state/sessions.db` (disposable cache): upsert/get/list of SessionRecord; enrichment from the worktree's `.sdlc-state/sessions/<id>/` (rounds, waiting) and the ledger (test-edit attempts, verifier).
2. prompts.ts: one prompt per job kind telling the agent which `mcp__sdlc__*` tools to call, the change id, the target and the done rule.
3. launcher.ts: preconditions (change valid; build needs a target, prefilled from the acceptance line; mode ≤ eligibility; review backlog ≤ ceiling); worktree `.sdlc-state/worktrees/<branch>` on `sdlc/<CHG>/<artifact>` or `<CHG>/<task>`; per-session `mcp.json` with `SDLC_SESSION`/`SDLC_CHANGE`; `session.started` committed on the branch; spawn `claude -p … --output-format stream-json --verbose --permission-mode plan|acceptEdits --mcp-config … --allowedTools … --session-id <uuid>` (SUPERVISED: prepare everything and hand back the command instead of spawning).
4. observer.ts: parse stream-json (init → modelPin, result → cost/turns/error), heartbeat per line, transcript teed to `stream.jsonl`, `session.stopped` committed on exit unless report_done already did.
5. server: registry-backed sessions in the snapshot; POST /api/sessions, /api/sessions/:id/stop|takeover|message|raise-cap; `sdlc serve` passes its bin path for `.mcp.json`.
6. cli: `sdlc session start|list|stop`; start runs inline and waits for the harness to exit.
7. web: Sessions view (cards, mode chips, waiting-on-you, verifier, rationale, header "N active · review backlog M", New session form, footer callout).
8. Tests with `SDLC_CLAUDE_BIN` pointing at a fake harness script; decisions; tick 1.6.

## Risks
- `claude -p` cannot take input mid-run; "add guidance" relaunches with `--resume` and the guidance as the prompt.
- The fake harness cannot call MCP tools; the real end-to-end run at the end of Phase 1 covers that path.

## Proof
pnpm build, pnpm test (sessions.test.ts, serve.test.ts, render.test.tsx), pnpm lint.

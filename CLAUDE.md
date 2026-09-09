# SDLC Console

A console over a git repo that runs an AI-native SDLC: six stages, one committed artifact each, humans decide at gates, agents work between them. Read `docs/decisions.md` before any architectural choice. Full spec: `docs/blueprint/` (grep it; don't load it all). How the repository was bootstrapped, for history only: `docs/bootstrap/`.

## How work happens here
This repository runs its own lifecycle. Every change lives in `sdlc/changes/CHG-NNNN/` and travels intent → spec → plan → build → PR → loop. `sdlc/config.yaml` is in GitHub mode: every gate is a PR merge on `main`, which is protected. Do not change code outside a change: start one with `sdlc change new --title "..."` (or in the console) and build on a task branch named `CHG-NNNN/<slug>` so the hooks in `.claude/hooks/` apply. A mistake made twice becomes a line in this file.

## Non-negotiables
- Files in git are the source of truth; stage is derived, never stored.
- No accept/merge/approve capability on any agent-facing surface (MCP, headless CLI).
- `packages/core` has no I/O — pure functions over a `Tree` snapshot. Adapters do I/O.
- No database except SQLite as a disposable cache in `.sdlc-state/`.
- The console parses `CLAUDE.md` / `.claude/**` / `REVIEW.md` / `bands.yaml`; it never edits them.
- Evidence (command output) is shown verbatim, never summarised.

## Stack
TypeScript strict, Node ≥ 22, pnpm workspaces. Packages: `schemas`, `core`, `adapters/git`, `adapters/github`, `adapters/gitlab`, `detect`, `server`, `cli`, `mcp`, `hooks`, `desktop`, `web` (React + Vite, plain CSS variables). Real `git` CLI via thin wrapper. Ajv JSON Schema + zod types, `gray-matter`. Vitest. No ORMs, no component frameworks, no router.

## Conventions
- Every `sdlc/` file has `schema: 1`. Schemas live in `packages/schemas` and generate types and MCP tool schemas.
- Transitions return write-plans `{files, events, commitMessage}`; only the git adapter commits.
- Fixture repos under `fixtures/` are the test oracle; golden tests for spec acceptance checks (a)–(n).
- Commit messages: `sdlc(<scope>): <what>`.

## Verifying your work
- Build: `pnpm build` (must finish with no errors)
- Test: `pnpm test` (all green; never skip or delete a failing test)
- Lint: `pnpm lint` (zero warnings)
- Test files: `packages/**/test/**/*.test.ts`, `packages/**/test/**/*.test.tsx`, `fixtures/test/**/*.test.ts`
Run all three before reporting a task complete, and paste the output. If a test fails, fix the code, not the test.

## Things to get right
- Don't store `stage` anywhere. Derive it.
- Don't let any agent-authored event be a `gate.accepted`. The validator rejects it.
- Don't add a "bypass" or "force" path to any gate or hook.

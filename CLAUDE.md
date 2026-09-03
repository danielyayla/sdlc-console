# SDLC Console

A console over a git repo that runs an AI-native SDLC: six stages, one committed artifact each, humans decide at gates, agents work between them. Read `docs/decisions.md` before any architectural choice. Work items in order from `docs/build-order.md`. Full spec: `docs/blueprint/` (grep it; don't load it all).

## Non-negotiables
- Files in git are the source of truth; stage is derived, never stored.
- No accept/merge/approve capability on any agent-facing surface (MCP, headless CLI).
- `packages/core` has no I/O — pure functions over a `Tree` snapshot. Adapters do I/O.
- No database except SQLite as a disposable cache in `.sdlc-state/`.
- The console parses `CLAUDE.md` / `.claude/**` / `REVIEW.md` / `bands.yaml`; it never edits them.
- Evidence (command output) is shown verbatim, never summarised.

## Stack
TypeScript strict, Node ≥ 22, pnpm workspaces. Packages: `schemas`, `core`, `adapters/git`, `adapters/github`, `server`, `cli`, `mcp`, `hooks`, `web` (React + Vite, plain CSS variables). Real `git` CLI via thin wrapper. Ajv JSON Schema + zod types, `gray-matter`. Vitest. No ORMs, no component frameworks, no router.

## Conventions
- Every `sdlc/` file has `schema: 1`. Schemas live in `packages/schemas` and generate types and MCP tool schemas.
- Transitions return write-plans `{files, events, commitMessage}`; only the git adapter commits.
- Fixture repos under `fixtures/` are the test oracle; golden tests for spec acceptance checks (a)–(n).
- Commit messages: `sdlc(<scope>): <what>`.

## Verifying your work
- Build: `pnpm build` (must finish with no errors)
- Test: `pnpm test` (all green; never skip or delete a failing test)
- Lint: `pnpm lint` (zero warnings)
Run all three before reporting a task complete, and paste the output. If a test fails, fix the code, not the test.

## Things to get right
- Don't store `stage` anywhere. Derive it.
- Don't let any agent-authored event be a `gate.accepted`. The validator rejects it.
- Don't add a "bypass" or "force" path to any gate or hook.

---
id: CHG-0013
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "With Claude Code hook JSON on stdin in a seeded worktree on CHG-0018/export-fix: `sdlc hook test-freeze` exits 2 for an edit under test/** and 0 for src/**, `sdlc hook plan-sync` exits 2 for a commit staging a file outside plan.md and 0 otherwise, `sdlc hook verify-before-done` runs the CLAUDE.md commands, records the round and exits 2 when one is red; every block appends a hook.blocked event; sdlc init installs the wrappers and settings.json when absent; build/test/lint green"
schema: 1
---
# Plan: Hooks package (1.4) (from spec.md n/a)

## Files that change
pnpm-workspace.yaml
tsconfig.json
vitest.config.ts
packages/hooks/package.json (new)
packages/hooks/tsconfig.json (new)
packages/hooks/tsconfig.build.json (new)
packages/hooks/src/index.ts (new)
packages/hooks/src/input.ts (new)
packages/hooks/src/ledger.ts (new)
packages/hooks/src/context.ts (new)
packages/hooks/src/plan-sync.ts (new)
packages/hooks/src/test-freeze.ts (new)
packages/hooks/src/verify-before-done.ts (new)
packages/hooks/src/run.ts (new)
packages/hooks/src/install.ts (new)
packages/hooks/test/index.test.ts (new)
packages/hooks/test/hooks.test.ts (new)
packages/cli/package.json
packages/cli/tsconfig.build.json
packages/cli/src/commands/hook.ts (new)
packages/cli/src/commands/init.ts
packages/cli/src/main.ts
packages/cli/test/cli.test.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Scaffold `@sdlc/hooks` (deps: core, schemas, adapter-git).
2. input.ts: Claude Code hook JSON (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `stop_hook_active`), never throws.
3. context.ts: worktree root, change id from the branch name (`CHG-NNNN/...`) or `SDLC_CHANGE`, repo + view at the worktree HEAD.
4. ledger.ts: append `hook.blocked` / `hook.allowed` / `round` events to the working-tree `log.jsonl` with the session's agent actor and the next seq.
5. plan-sync (Bash `git commit`): staged files vs plan files through `check.planSync`; test-freeze (Edit/Write/MultiEdit/NotebookEdit): `check.testFreeze`; verify-before-done (Stop): run the CLAUDE.md verification commands, record the round under `.sdlc-state/sessions/<id>/rounds.jsonl` and in the ledger, then `check.verifyBeforeDone`.
6. run.ts: `runHook(name, input)` → `{allowed, reason, exitCode}`; fail-open with a stderr note on internal errors; hooks outside a change context allow silently.
7. install.ts: wrappers `.claude/hooks/<name>.sh` and a `.claude/settings.json` (create-only; existing files untouched, snippet printed).
8. CLI `sdlc hook <name>` (stdin → exit 0/2); `sdlc init` installs hooks.
9. Tests over a seeded temp repo with a task worktree; decisions; tick 1.4.

## Risks
- Claude Code's hook JSON may gain fields; the parser ignores unknown keys and treats missing ones as "no context" (allow).
- verify-before-done runs real commands; tests use `true`/`false` commands to stay fast.

## Proof
pnpm build, pnpm test (packages/hooks/test, cli hook tests), pnpm lint.

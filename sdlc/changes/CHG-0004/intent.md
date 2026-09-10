---
id: CHG-0004
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-10T09:10:35Z
status: draft
schema: 1
---
# Intent: Root eslint ignores .sdlc-state session worktrees

## Problem
`pnpm lint` (`eslint . --max-warnings 0`) fails from the root checkout with ~1970
"Parsing error: No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present"
errors whenever the engine has created session worktrees under `.sdlc-state/worktrees/`.
Each worktree is a full checkout carrying its own `tsconfig.json`, so typescript-eslint sees
several candidate roots and refuses to parse. `pnpm exec eslint . --max-warnings 0 --ignore-pattern '.sdlc-state/**'`
is clean, which confirms the cause. Anyone running the documented "verify your work" steps
while a session is (or was) active gets a red lint that has nothing to do with their change.

## Proposed outcome
`pnpm lint` from the root checkout is green regardless of how many session worktrees exist
under `.sdlc-state/`. The disposable cache directory is ignored by the root ESLint config,
the same way `dist/` and `node_modules/` already are.

## Affected users and systems
- Anyone running `pnpm lint` in the root checkout (humans and the verify-before-done hook).
- `eslint.config.js` (root) only. No package code changes.

## Constraints
- `.sdlc-state/` is the disposable cache (CLAUDE.md non-negotiables); nothing in it is source.
- Keep the fix to the `globalIgnores([...])` list with a one-line comment explaining why.

## Open questions
None.

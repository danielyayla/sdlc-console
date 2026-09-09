---
id: CHG-0002
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-09T15:20:10Z
status: draft
schema: 1
---
# Intent: hooks tests fail inside a launched session — scrub the launcher env

## Problem
`pnpm test` goes red inside any session the console launched, and green everywhere else. The launcher exports `SDLC_CHANGE` and `SDLC_SESSION` for the hooks, and `changeIdFrom` in `packages/hooks/src/context.ts` prefers `SDLC_CHANGE` over the task branch name. `packages/hooks/test/hooks.test.ts` builds throwaway worktrees on `CHG-0018/export-fix` and `CHG-0017/export` and calls `runHook` without an `env`, so `runHook` falls back to `process.env`, resolves the session's change (CHG-0001 today) instead of the test's, and six of the nine hook tests exit 0 where they expect a block (test-freeze ×2, plan-sync, verify-before-done ×2, production-gate). Seen on 2026-09-09 in the CHG-0001 build session: the `verify-before-done` Stop hook runs the suite under the session env, recorded round 2 red, and blocked completion of a change whose code was 552/552 green with the two variables unset. Every session that ends with a `pnpm test` in its verification block hits this; the hook's own note on CHG-0001 records the diagnosis.

## Proposed outcome
The hooks test suite is independent of the environment it runs in: `pnpm test` is green inside a launched session and outside it, with no `env -u` workaround. The hooks keep honouring `SDLC_CHANGE` and `SDLC_SESSION` from a real launcher (a band session has no change branch to read); the test passes an explicit env to `runHook` that carries the process env minus the two launcher variables, so the throwaway worktree's branch name decides the change. The `verify-before-done` round of a build session then measures the code, not the harness.

## Affected users and systems
- Engineers running or reading build sessions: the Stop hook's verification round and the `hook.blocked` ledger lines it writes.
- `packages/hooks/test/hooks.test.ts` (the fix); `packages/hooks/src/run.ts` already accepts `opts.env`, so no source change is expected.
- Nothing in `packages/core`, the CLI, the server, or the web console.

## Constraints
- Do not change how `changeIdFrom` or `parseHookInput` read the launcher env: a session launched for a band or for a product directory relies on it.
- Kind is `feature`, not `fix`, on purpose: the change is a test edit, and a `fix` would freeze `packages/hooks/test/**` behind a repro. The failing run itself is the repro (CHG-0001 round 2, 2026-09-09).
- One file; the plan-sync hook holds the commit to it.

## Open questions
- Whether `runHook` should default to a scrubbed env when the input names a `cwd` on a `CHG-NNNN/<slug>` branch, so future tests cannot regress the same way. That is a source change in `packages/hooks/src/run.ts`; the spec decides whether it rides here or stays a test-only change.
- Whether `verify-before-done` should itself unset `SDLC_CHANGE` and `SDLC_SESSION` for the commands it runs (`packages/hooks/src/verify-before-done.ts` spreads `process.env`). It would mask the same class of bug in other packages' tests, so the default answer is no.

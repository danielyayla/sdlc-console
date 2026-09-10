---
id: CHG-0005
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-10T09:18:37Z
status: draft
schema: 1
---
# Intent: Engine close awaits spawned sessions so test cleanup does not race the ledger commit

## Problem
`pnpm test` fails intermittently on `packages/server/test/github.test.ts` ›
"a decision committed on the PR branch but not yet merged does not launch the next stage's session; the merge does"
with `ENOTEMPTY: directory not empty, rmdir .../clone/.git/objects` raised by the `afterEach`
cleanup's recursive `rmSync`. The test passes when run alone and fails under full-suite load.

The engine auto-launches a plan session (the fake Claude harness). When the harness exits, the
launcher's observer commits a `session.stopped` ledger line into the session worktree, which writes
into the clone's shared object store. `Engine.launch` discards the launcher's `finished` promise
and `Engine.close()` is synchronous, so nothing in the test can wait for that commit; the test
papers over the race with a 300 ms sleep in its cleanup.

## Proposed outcome
The engine keeps track of every session it spawns and `close()` returns a promise that resolves
once those sessions have exited and their exit ledger commits are done. The test's cleanup awaits
`engine.close()` before removing the temp directory and the sleep goes. `pnpm test` from the root
checkout passes at least twice in a row.

## Affected users and systems
- `packages/server/src/engine/engine.ts` (`launch`, the resume launch in `onSessionExit`, `close`).
- `packages/server/test/github.test.ts` (the failing test and its cleanup).
- `sdlc serve` shutdown, which already calls `engine.close()` and keeps working with a promise-returning close.

## Constraints
- Fix the code or the test wiring; never delete, skip, or loosen the test.
- No behaviour change for launched sessions themselves: `close()` waits, it does not kill.
- A bounded retry of `rmSync` is second best and only if a real await is impossible.

## Open questions
None.

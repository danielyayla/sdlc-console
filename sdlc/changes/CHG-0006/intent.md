---
id: CHG-0006
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-10T10:24:15Z
status: draft
schema: 1
---
# Intent: Engine: session exit after close must not crash the process

## Problem
`Engine.onSessionExit` is invoked from the launcher's `onExit` callback as a discarded promise (`void this.onSessionExit(s)`, six sites across engine.ts and http.ts). It checks `closed` only at entry, then awaits deploy recording and `runForSession` → `store.refresh(true)` → `readTree`. If the engine is closed (or the repo removed) while that chain is in flight, the git call rejects and nobody catches it: an unhandled rejection, which is fatal in a real `sdlc serve` process on Node ≥ 15. In the test suite it surfaces intermittently (2 of 3 full-suite runs on 2026-09-10 under load, never when the file runs alone) as "Errors 1 error" from depth.test.ts after all 553 tests pass.

## Proposed outcome
Rejections from the session-exit chain are caught and logged by the engine, never left unhandled, and a closed engine stops after each await instead of touching the repo. The full suite finishes with zero errors on repeated runs.

## Affected users and systems
`packages/server` engine (`onSessionExit` and the per-session helpers it awaits). Anyone running `sdlc serve --engine`. `packages/core` is untouched.

## Constraints
Fix belongs in the engine, not the test. No change to `packages/core`. `pnpm build`, `pnpm test` (full suite at least twice), and `pnpm lint` must be green.

## Open questions
None.

---
id: CHG-0005
artifact: spec
cycle: 1
intent_sha: 53a83536fc39a1cc915b5768322f17ec765b41ec
prompt_ref: prompts/design-pass@1
skills: []
concerns:
  - id: C1
    policy: CLAUDE.md How work happens here — every change travels intent → spec → plan → build → PR; docs/decisions.md principle 3 (a gate decision is a human-authored merge) and 1.7 (the PR follows a green per-change run)
    owner: po
    resolved: false
    note: "The code this intent asks for is already on main: commit 41d7ce3 (branch CHG-0005/engine-close-awaits-sessions) merged as PR #53 (a74cea8) before gate 1 was recorded (310ae05) and with no spec, plan, run file or pr.yaml on the change. This spec therefore describes main as the baseline and leaves the plan only the residue (R5–R7). The PO decides whether that is acceptable for this change or whether the ledger should carry a note explaining the order; nothing in git can be undone by the console."
  - id: C2
    policy: intent.md Affected users and systems — `sdlc serve` shutdown keeps working with a promise-returning close; intent Constraints — close() waits, it does not kill; docs/decisions.md 1.6 (session.stopped is committed by the observer on the session branch)
    owner: tech_lead
    resolved: false
    note: packages/server/src/serve.ts:119 discards the promise (`void engine?.close()`), so `sdlc serve` on SIGINT still exits while a spawned session may be running; if the process dies first, that session's session.stopped commit is never written (pre-existing). Waiting would hold shutdown for as long as a Claude session runs. R5 keeps fire-and-forget with the comment already on main; the tech lead should confirm, or ask for a bounded wait in a separate change.
  - id: C3
    policy: "intent.md Constraints — no behaviour change for launched sessions: close() waits, it does not kill; CLAUDE.md Things to get right — no bypass or force path"
    owner: tech_lead
    resolved: false
    note: "close() has no timeout: `while (outstanding.size > 0) await Promise.all(...)` (engine.ts:121) waits for as long as a harness runs. In tests the only bound is the `it` timeout (60 s in github.test.ts). The spec adds no timeout and no kill option (R2); flagged so the decision is explicit."
  - id: C4
    policy: intent.md Proposed outcome — the engine keeps track of every session it spawns; docs/decisions.md 1.7 — the engine is opt-in and every step is available manually (sdlc session start, POST /api/sessions)
    owner: tech_lead
    resolved: false
    note: Sessions launched through the HTTP API (packages/server/src/http.ts:49, 588, 619) and the CLI (packages/cli/src/commands/session.ts:27) are not in the engine's outstanding set; their exit handling is still `void engine.onSessionExit(s)`. They are not spawned by the engine, so R1 does not cover them; CHG-0006 names those sites. The tech lead should confirm the boundary so the two changes do not both edit http.ts.
  - id: C5
    policy: "CHG-0006 intent (Engine: session exit after close must not crash the process) — rejections from the session-exit chain are caught and logged by the engine; CLAUDE.md Non-negotiables — evidence is shown verbatim"
    owner: tech_lead
    resolved: false
    note: track() (engine.ts:125-128) attaches a handler that swallows rejections of the tracked exit handling, so engine-spawned sessions no longer produce an unhandled rejection — but nothing is logged. CHG-0006's intent still describes six `void this.onSessionExit` sites; three of them are now `track(...)`. This spec leaves track() silent (R7) and expects CHG-0006 to add the log inside onSessionExit; the tech lead should confirm that split.
  - id: C6
    policy: CLAUDE.md Verifying your work — never skip or delete a failing test; if a test fails, fix the code, not the test; intent Constraints — fix the code or the test wiring, never delete, skip or loosen the test
    owner: tech_lead
    resolved: false
    note: "packages/server/test/github.test.ts changed in 41d7ce3: the 300 ms cleanup sleep went and two assertions were added (session status done; the plan branch's head commit is the session's exit). No `it` was removed, renamed or weakened, and the fix is in engine.ts. R6 keeps that rule for the residue: the three test files in R5 gain an `await`, nothing else."
  - id: C7
    policy: "docs/decisions.md 0.2 (`kind: feature|fix`) and 2.7 (repro-first fix flow; test-freeze behind a committed repro); intent Problem — this is an intermittent test failure, i.e. a bug"
    owner: po
    resolved: false
    note: "change.yaml says `kind: feature`, so the test-freeze hook does not apply and no repro is required, although the change fixes a defect. The only credible repro is the full suite under load, which no single test file can commit. The spec assumes `feature` stays (as CHG-0002 did); the PO owns kind and risk."
  - id: C8
    policy: plan-sync hook (FR-41, .claude/hooks/plan-sync.sh; docs/decisions.md 0.6) — every committed file must be listed under plan.md "Files that change"
    owner: eng
    resolved: false
    note: The residue touches packages/cli/src/commands/run.ts, packages/server/test/depth.test.ts, packages/server/test/maintain.test.ts, packages/server/test/products.test.ts and packages/server/test/engine.test.ts (R5, R6). plan.md must list exactly those; engine.ts and github.test.ts are already on main and must not reappear unless R6's test needs a helper there.
  - id: C9
    policy: CLAUDE.md Verifying your work — run build, test and lint before reporting done and paste the output; CLAUDE.md Non-negotiables — evidence is shown verbatim, never summarised; CHG-0007 intent (session worktrees start without dependencies)
    owner: eng
    resolved: false
    note: The intent's done signal is `pnpm test` from the root checkout green at least twice in a row. A session worktree has no node_modules until CHG-0007 lands, so the build session's verify-before-done round may be red for environment reasons. R7 requires the two consecutive runs to be pasted verbatim from an installed checkout into the plan's Proof; a red round caused by `command not found` is not evidence against the fix.
  - id: C10
    policy: spec front-matter `skills` (packages/schemas/src/frontmatter.ts:44) and the session task — apply the org skills under .claude/skills
    owner: tech_lead
    resolved: false
    note: This worktree has no .claude/skills directory (only .claude/hooks and .claude/settings.json), so no org skill was applied and `skills` is `[]`, as in CHG-0002 C8.
created: 2026-09-10T10:33:52Z
context_manifest: sha256:f6b82f3e17142e00874f5b8710cfd5e12fd65c5771f3bc337d7575057e6da275
schema: 1
---
# Spec: Engine close awaits spawned sessions so test cleanup does not race the ledger commit

The intent (accepted at gate 1, sha `53a83536`) describes one race: the engine auto-launches a plan session, the launcher's observer commits `session.stopped` into the session worktree (and so into the clone's shared object store) when the harness exits, and the test's `afterEach` removes the temp directory before that commit lands, so `rmSync` fails with `ENOTEMPTY` under full-suite load. Two things let the race happen: `Engine.launch` discarded the launcher's `finished` promise, and `Engine.close()` was synchronous, so nothing could wait.

The proposed outcome is already on `main`: commit `41d7ce3` (branch `CHG-0005/engine-close-awaits-sessions`, PR #53, merged as `a74cea8`) landed before gate 1 was recorded (`310ae05`), with no spec, plan or run file on the change (C1). This spec therefore states the requirements against `main`, records for each where `main` stands, and leaves the plan the residue: the call sites that still discard the promise, a regression test that does not depend on suite load, and the two-consecutive-runs proof the intent asks for.

## Requirements

R1. **`close()` returns a promise that resolves only when nothing the engine started can still write to the repository.** After `await engine.close()`: no pass is in flight, no code-host sync is in flight, every session this engine spawned (design/plan/build/review/propose via `launch`, the automatic resume in `runForSession`, band sessions via `detect`) has exited, its `session.stopped` ledger commit is done (or the observer has given up after its five attempts and recorded the failure on the session), and the exit handling `onSessionExit` set off — including a resume session it launched — has settled. A caller may remove the checkout afterwards. Done signal: the `github.test.ts` test "a decision committed on the PR branch but not yet merged …" awaits `close()`, asserts the plan session's status is `done` and that the head commit of `sdlc/CHG-0022/plan` is `session <id> done`, and passes under full-suite load. State on `main`: met (`packages/server/src/engine/engine.ts:113-128`, test lines 450-455).

R2. **`close()` waits; it does not kill, time out or bypass.** A running harness ends on its own; `close()` has no timeout option and no kill path (C3). Calling `close()` twice, or on an engine that spawned nothing, resolves at once. State on `main`: met (`closed` flag, empty `outstanding` set); the double call is exercised by the test above, which both awaits `close()` inline and holds `engine.close()` in its cleanup list.

R3. **`tick()` resolves with the pass that covers the caller.** A `tick()` that arrives while a pass is in flight queues one more pass and resolves when that pass is done, so `await engine.tick()` always means a pass over state at least as new as the call, including the sessions it launched. This is the second half of the race (the store-subscribe tick was still adding the plan worktree when the test ended). State on `main`: met (`engine.ts:273-290`).

R4. **The failing test keeps its name and every assertion; the sleep is gone.** `packages/server/test/github.test.ts` contains no `setTimeout` in the cleanup of that test; the cleanup awaits `engine.close()` before `rmSync`. No `it` in the file is deleted, skipped or loosened (C6). State on `main`: met (`41d7ce3` removed `cleanups.push(() => new Promise((r3) => setTimeout(r3, 300)))` and added the two assertions in R1).

R5. **No caller discards the promise silently.** Every `engine.close()` call either awaits it or carries a comment naming why it does not. Residue for the plan:
- `packages/cli/src/commands/run.ts:17` — `engine.close();` becomes `await engine.close();` (with `autoLaunch: false` the engine spawns nothing, so the await costs nothing and the CLI stops relying on that).
- `packages/server/test/depth.test.ts:84`, `packages/server/test/maintain.test.ts:211` — `engine.close();` becomes `await engine.close();`.
- `packages/server/test/products.test.ts:194` — the harness's `close` becomes `async () => { await engine.close(); registry.close(); }` and its callers await it (lines 172-173, 218, 226, 241).
- `packages/server/src/serve.ts:119` — stays `void engine?.close()` with its comment: shutdown stops timers now and neither waits for nor kills spawned sessions (C2). No other production call site exists; the HTTP and CLI session launches are outside the engine and out of scope (C4).

R6. **A regression test that fails without the fix and without suite load.** One new `it` in `packages/server/test/engine.test.ts`: with `autoLaunch: true` and the fake harness held alive (`FAKE_CLAUDE_SLEEP=1`), accept gate 1 on CHG-0022 so the design pass launches, `await engine.tick()`, then `await engine.close()` and assert, without any sleep, that the launched session's status is `done` (not `stopped` — nothing was killed) and that the session branch's head commit subject is `session <id> done`. On `main` before `41d7ce3` this test fails (close returned before the harness exited); on `main` today it passes. Its cleanup removes the temp directory with no sleep.

R7. **Proof.** `pnpm build`, `pnpm test` and `pnpm lint` green; `pnpm test` from the root checkout run twice in a row, both green, the output of both runs pasted verbatim into the plan's Proof and the build session's round (C9). No change to `packages/core`, `packages/server/src/sessions/launcher.ts`, `observer.ts`, the MCP server or the hooks; `track()` stays as it is on `main` (C5).

R8. **Unchanged.** Session modes, the launcher's `LaunchResult.finished` contract, the observer's retry of the `session.stopped` commit, job keys, `EngineOptions` (no new option), `sdlc serve` shutdown semantics.

## Design

The design has four parts: an audit of where `main` stands against each intent line, the mechanism as merged in `41d7ce3` (so the plan and the reviewer can check it rather than rediscover it), the reason `sdlc serve` keeps a fire-and-forget close, and the residue with its file list and commits. No data, schema, core or launcher change is involved; everything here lives in `packages/server` and one CLI command.

### Where `main` stands against the intent
Verified against `main` at `8b19405` (worktree HEAD `f32da76`).

| Intent line | State |
|---|---|
| Engine keeps track of every session it spawns | met — `outstanding: Set<Promise<void>>` (`engine.ts:92`), `track()` (`:125-128`), called on `r.finished` and on `onExit` at the three launch sites (`:230-232`, `:658-662`, `:823-827`) |
| `close()` returns a promise resolving after exits and their ledger commits | met — `engine.ts:113-122`: sets `closed`, unsubscribes, clears the detection timer, awaits the running pass, the sync in flight, then loops over `outstanding` until empty |
| `close()` waits, does not kill | met — no `stopSession` call anywhere in `close()` |
| Test cleanup awaits `close()`, sleep gone | met — `github.test.ts:450-455` |
| `sdlc serve` shutdown keeps working | met, not waiting — `serve.ts:119` (`void engine?.close()`), decision recorded as a comment (C2) |
| `pnpm test` from the root checkout passes at least twice in a row | open — no evidence on the change; the PR merged without a run file (C1, C9) |
| Callers that discard the new promise | open — `cli/run.ts:17`, `depth.test.ts:84`, `maintain.test.ts:211`, `products.test.ts:194` (R5) |
| A test that proves the wait without suite load | open — the only guard is the load-dependent test (R6) |

### Mechanism (as merged)
- **Tracking.** `track(work)` wraps a promise so that it resolves regardless of outcome and removes itself from `outstanding` when settled; the wrapper attaches a rejection handler to the original, so an engine-spawned session's exit handling cannot become an unhandled rejection (it is also not logged — C5). Two promises are tracked per launch: the launcher's `finished` (resolves after the observer's `onExit`, i.e. after the `session.stopped` commit or its recorded failure) and `onSessionExit(s)` (deploy records, review mirror, proposal filing, per-change run, and possibly a resume launch that adds two more entries).
- **Why a loop.** `Promise.all([...outstanding])` snapshots the set; a resume session launched during exit handling is added after the snapshot, so `close()` repeats until the set is empty. Termination follows from the harness exiting (R2 accepts that a hung harness hangs `close()`; C3).
- **Order in `close()`.** `closed` first, so `tick()` and `sync()` return without work and `forWritebacks` stops between items; then the pass and the sync in flight, because either may still be launching a session that must be tracked before the `outstanding` loop starts; then the loop.
- **`tick()` as a covering pass.** `running` holds the promise of the current pass loop; a caller arriving mid-pass sets `pending` and receives that same promise, which resolves only after the queued pass has run. The test in R1 relies on this: its explicit `tick()` resolves after the store-subscribe tick that launched the plan session.

### Why `sdlc serve` keeps fire-and-forget
`sdlc serve` exits on SIGINT/SIGTERM through `server.close()` → each product's `close()` (`packages/cli/src/main.ts:320-325`, `serve.ts:116-121`, `:171-176`). Awaiting the engine there would hold the process until every spawned Claude session finishes, which the intent forbids turning into a kill and which nobody asked to become a wait. The cost — a session whose `session.stopped` commit is lost when the process dies first — predates this change and is carried forward (Open questions). The spec keeps the merged behaviour and the comment; C2 hands the choice to the tech lead.

### Residue, files and commits
- Files that change (5, under `thresholds.autoFilesMax: 12`; coverage is lenient and CLAUDE.md has a test target, so the build session is AUTO-eligible): `packages/cli/src/commands/run.ts`, `packages/server/test/depth.test.ts`, `packages/server/test/maintain.test.ts`, `packages/server/test/products.test.ts`, `packages/server/test/engine.test.ts` (C8).
- Two commits: `sdlc(server): await engine.close() at every call site that can wait` (R5) and `sdlc(server): close() waits for a live harness — regression test without suite load` (R6). Test edits add awaits and one `it`; nothing is removed (C6).
- The R6 test uses the existing `waitFor` helper only to reach the launched job; the assertion after `close()` uses no wait at all, which is what makes it a test of `close()` rather than of the fake harness.
- Proof (R7) in the plan and the build session's rounds, verbatim.

### Out of scope
Timeouts or kill options on `close()` (C3); tracking of sessions launched through `POST /api/sessions`, resume/guidance endpoints or `sdlc session start` (C4, CHG-0006); logging of swallowed exit-handling errors (C5, CHG-0006); installing dependencies into session worktrees (C9, CHG-0007); the remaining fixed sleeps in other server tests (Open questions).

## Areas of concern
Each concern is carried in the front-matter as `{id, policy, owner, resolved: false, note}`; none is resolved here.

- **C1 · code merged ahead of the lifecycle** — policy: CLAUDE.md "How work happens here" (intent → spec → plan → build → PR); decisions.md principle 3 and 1.7. Owner: po. PR #53 merged the fix before gate 1 was recorded and without spec, plan, run or `pr.yaml` on the change. This spec treats `main` as the baseline; the PO decides whether a ledger note should say so.
- **C2 · `sdlc serve` shutdown discards the promise** — policy: intent "serve keeps working with a promise-returning close" and "waits, does not kill"; decisions.md 1.6. Owner: tech_lead. Fire-and-forget stays (R5); confirm or ask for a bounded wait separately.
- **C3 · unbounded wait** — policy: intent constraint "close() waits, it does not kill"; CLAUDE.md "no bypass or force path". Owner: tech_lead. No timeout, no kill option; a hung harness hangs `close()`; the `it` timeout is the only bound in tests.
- **C4 · sessions launched outside the engine are not tracked** — policy: intent "every session it spawns"; decisions.md 1.7. Owner: tech_lead. `http.ts:49/588/619` and `cli/session.ts:27` still use `void engine.onSessionExit`; CHG-0006 names them. Confirm the boundary so the two changes do not both edit `http.ts`.
- **C5 · swallowed rejections vs CHG-0006** — policy: CHG-0006 intent (caught *and logged*); CLAUDE.md evidence verbatim. Owner: tech_lead. `track()` handles rejections silently; the log belongs to CHG-0006's edit of `onSessionExit`.
- **C6 · test edits under "fix the code, not the test"** — policy: CLAUDE.md Verifying your work; intent Constraints. Owner: tech_lead. `41d7ce3` removed a sleep and added assertions; no `it` was weakened. The residue adds awaits and one `it`.
- **C7 · a defect filed as `kind: feature`** — policy: decisions.md 0.2 and 2.7 (repro-first fix flow, test-freeze). Owner: po. No repro can be committed for a load-dependent race; the spec assumes `feature` stays.
- **C8 · plan-sync file list** — policy: FR-41 plan-sync hook; decisions.md 0.6. Owner: eng. Exactly the five files above; `engine.ts` and `github.test.ts` are on `main` already.
- **C9 · proof environment** — policy: CLAUDE.md Verifying your work and evidence verbatim; CHG-0007. Owner: eng. Two consecutive green `pnpm test` runs from an installed checkout, pasted verbatim; a `command not found` round in an uninstalled worktree is not evidence against the fix.
- **C10 · no org skills in the repository** — policy: spec front-matter `skills`; the session task. Owner: tech_lead. `.claude/skills` does not exist; `skills: []`.

## Open questions carried forward
- From intent: none were carried; the intent listed no open questions.
- Whether `sdlc serve` should wait for spawned sessions (with a bound) on shutdown, or keep exiting while they run — and, if it keeps exiting, whether a session whose `session.stopped` commit is lost that way should be reconciled on the next start (C2).
- Whether the other fixed sleeps that paper over the same class of race (`engine.test.ts:202`, `maintain.test.ts:204` and `:265`, `depth.test.ts:119`, all `setTimeout` in cleanup after a fake-harness launch) should go in this change now that `close()` waits, or in a follow-up; the intent names only `github.test.ts`, so this spec leaves them.
- Whether tracking should extend to sessions launched through the HTTP API and CLI when an engine is present (C4) — a question for CHG-0006's spec.
- Whether the ledger should record that PR #53 merged ahead of the lifecycle (C1).

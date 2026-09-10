---
id: CHG-0006
artifact: spec
cycle: 1
intent_sha: 680ceae2e79e257ed9041d4aac41a0a9eee61da9
prompt_ref: prompts/design-pass@1
skills: []
concerns:
  - id: C1
    policy: intent.md Problem and Affected systems (accepted at gate 1, sha 680ceae2) — six discarded-promise sites across engine.ts and http.ts; docs/decisions.md preamble (a decision that turns out wrong is changed in a commit that says why)
    owner: po
    resolved: false
    note: "The intent's premise is partly overtaken: PR #53 (CHG-0005, commit 41d7ce3) merged at 13:23:45 +0300 on 2026-09-10, thirty seconds before this intent was committed (6311ae5, 13:24:16). On main today the three engine.ts sites (lines 230, 660, 825) go through `track()`, and only the three http.ts sites (lines 49, 588, 619) still discard the promise with `void`. The spec re-bases the requirements on the code as it is: the production defect (an unhandled rejection under `sdlc serve`) is intact on the http.ts path, the engine path now swallows silently instead of crashing, and `closed` is still checked only at entry. The PO should confirm the outcome still holds as written."
  - id: C2
    policy: CLAUDE.md Verifying your work — run build, test and lint and paste the output; intent.md Constraints — `pnpm test` full suite at least twice
    owner: eng
    resolved: false
    note: "The symptom is unverified on current main. The intent's observation (2 of 3 full-suite runs, depth.test.ts, 2026-09-10) predates PR #53, which awaited the exit handling the intent describes, and this spec worktree has no node_modules, so the suite could not be run here. R6 requires the plan's first step to run the full suite twice on main before the fix and record, verbatim, whether \"Errors 1 error\" still appears. The fix is required either way (R1) because the http.ts path is a fatal crash in a real process; the honest proof is the before/after pair."
  - id: C3
    policy: intent.md Proposed outcome — rejections are caught and logged by the engine; docs/decisions.md principle 5 — evidence is literal toolchain output, shown verbatim
    owner: tech_lead
    resolved: false
    note: "`Engine.track` (engine.ts:125-128) settles a rejecting `onSessionExit` with `.then(() => undefined, () => undefined)` and its comment says failures are the launcher's and the observer's to report. That is silent, not logged: a git failure on the exit path leaves no line anywhere. D1 moves the catch into `onSessionExit` itself with one log line carrying the error message verbatim (GitError embeds git's stderr), and `track` keeps its swallow only for `r.finished`, which never rejects. The tech lead confirms that a logged-and-settled exit is the intended contract and that `track`'s comment is corrected rather than left contradicting it."
  - id: C4
    policy: docs/decisions.md 1.7 and 2.4 — every exit-path action is a keyed job, claimed once per (session, head), retried by key; principle 1 — files in git are the source of truth; blueprint NFR Reliability — a crash mid-transition leaves the old or the new committed state, never a partial one
    owner: tech_lead
    resolved: false
    note: '"Stop after each await" (R3) means a chain in flight when `close()` is called does not finish its writes. Because `runPerChange`, `mirrorReview`, `recordDeploysForSession`, `mirrorProposal` and `recordBandSession` each commit atomically, what is on disk is either the old or the new state (principle 1 holds). What can be lost is cache-only: a job claimed before the close and never updated. D2 requires such a job to be updated to `failed` with the error `engine closed before <step>` so it is visible and a manual run (`runForChange`, trigger `manual`, a different key) stays possible; a claim is never made after close. The tech lead confirms `failed` (not `skipped`) is the right state for a job the engine abandoned.'
  - id: C5
    policy: "docs/decisions.md 1.6 — the session registry is a disposable SQLite cache; CHG-0005 (PR #53) decision recorded in its commit message — serve's shutdown keeps not waiting for `engine.close()`"
    owner: tech_lead
    resolved: false
    note: "`serve.ts:116-121` calls `void engine.close()` and then `registry.close()` at once, so any exit handling in flight at shutdown meets a closed better-sqlite3 handle (`jobs.list`, `jobs.update`, `registry.patch` throw synchronously inside the async chain). Today that is a rejection; with D1 it is a logged line. The CLI (`main.ts:320-325`) returns right after `server.close()`, so the process ends anyway. The spec leaves the ordering as CHG-0005 decided it and does not add an await with a bound; the tech lead decides whether that becomes its own change (Open questions)."
  - id: C6
    policy: intent.md Affected users and systems — `packages/server` engine (`onSessionExit` and the helpers it awaits); CLAUDE.md How work happens here — do not change code outside a change
    owner: po
    resolved: false
    note: "The same failure class exists one layer down, outside the intent's scope: `observer.ts:89` runs `void Promise.resolve(opts.onExit?.(…)).finally(() => resolve(code))`, and `.finally` re-propagates a rejection from the launcher's async `onExit` (`launcher.ts:266-292`: `nextSeq`, `registry.get`, `registry.patch`, `readRounds`), so that rejection is unhandled too; `observer.ts:88` calls `registry.patch` synchronously inside the child's `exit` event, which on a closed registry is an uncaught exception. R1–R5 fix the engine only, as the intent asks. The PO decides whether the observer/launcher hardening rides in this change (one `.catch` in observer.ts, one try/catch around the launcher's `onExit`) or is filed as its own change (Open questions)."
  - id: C7
    policy: intent.md scope — the session-exit chain; docs/decisions.md 1.7 — the engine observes derived state and turns transitions into keyed jobs
    owner: po
    resolved: false
    note: "`Engine.tick()` is discarded with `void` from the store subscription (`engine.ts:95`) and from `serve.ts:150`; inside `pass()` the `readTree` at `engine.ts:298` is outside every catch, so a git failure during a pass (repo removed, transient index lock) is an unhandled rejection by the same mechanism. It is not the session-exit chain and this spec leaves it alone. The PO decides whether the one-line guard (`.catch` in the subscription and in `startServer`) rides here (Open questions)."
  - id: C8
    policy: "docs/decisions.md 0.2 (`kind: feature|fix`) and 2.7 (repro-first fix flow: a fix freezes `packages/**/test/**` behind a committed repro); .claude/hooks/test-freeze.sh"
    owner: po
    resolved: false
    note: "change.yaml says `kind: feature` for what is a bug fix. Under `kind: fix` the test-freeze hook would block the regression test R5 adds until a repro is committed, and the repro here would be that very test. The spec assumes `feature` stays (as CHG-0002 did for the same reason) and treats R5 as the regression guard. If the PO prefers `fix`, the intent must come back with a repro strategy (a test committed red before the engine change, then the fix)."
  - id: C9
    policy: 'plan-sync hook (FR-41, .claude/hooks/plan-sync.sh, docs/decisions.md 0.6): every committed file must be listed under plan.md "Files that change"'
    owner: eng
    resolved: false
    note: D6 lists `packages/server/src/engine/engine.ts` and one test file under `packages/server/test/`. `packages/server/src/http.ts` is unchanged by D1 (the guarantee moves into the callee); if the build session edits it for the explicit form, the plan must list it first. `packages/core`, `observer.ts`, `launcher.ts`, `serve.ts` and `depth.test.ts` are outside the plan unless the PO widens scope (C6, C7).
  - id: C10
    policy: spec front-matter `skills` (packages/schemas/src/frontmatter.ts:44) and the task's instruction to apply the org skills under .claude/skills
    owner: tech_lead
    resolved: false
    note: This worktree has no `.claude/skills` directory (only `.claude/hooks` and `.claude/settings.json`), so no org skill was applied and `skills` is `[]`; the same gap was recorded on CHG-0002 (C8). If a skill is expected to shape specs, it is missing from the repository, not skipped by this session.
  - id: C11
    policy: CLAUDE.md Verifying your work — `pnpm lint` with zero warnings; CLAUDE.md — a mistake made twice becomes a line in this file
    owner: tech_lead
    resolved: false
    note: "`eslint.config.js` uses `tseslint.configs.strict` without type information, so `@typescript-eslint/no-floating-promises` is not on and `void somePromise()` lints clean. This is the second change in a day (after CHG-0005) about a discarded promise on the exit path. The spec does not add a lint rule (type-aware linting changes the lint's cost for every package) and carries the question forward; a CLAUDE.md line is the cheaper guard."
  - id: C12
    policy: docs/decisions.md 1.4 — verify-before-done runs the CLAUDE.md verification commands itself on Stop and blocks unless the round is green with output; CLAUDE.md Verifying your work
    owner: eng
    resolved: false
    note: "Session worktrees under `.sdlc-state/worktrees/` are created without `node_modules` (this spec worktree has none; CHG-0001 ledger seq 23 recorded `tsc: command not found`). The build session's Stop-hook round will be red for environment reasons, not code reasons, unless the worktree is installed first. R6's proof must come from an installed worktree, and the round the ledger records is only evidence when it ran the real commands. The launcher-side fix remains the separate change CHG-0002 carried forward."
created: 2026-09-10T10:36:08Z
context_manifest: sha256:07391b27a5eecfcb4230133521ecfc368d683044b484498908d9a396162ebea1
schema: 1
---
# Spec: Engine: session exit after close must not crash the process

The intent (accepted at gate 1, sha `680ceae2`) describes one defect: the launcher's `onExit` hands a finished session to `Engine.onSessionExit`, whose promise is discarded, and the chain it awaits (`store.refresh(true)` → `headSha` and `readTreeWithBranches`, then the per-session helpers) can reject after the engine was closed or the repository removed. Nobody catches that rejection. Under Node ≥ 15 an unhandled rejection is fatal, so in `sdlc serve --engine` it ends the process; under Vitest it is reported as "Errors 1 error" after every test passed, which is the intermittent failure the intent saw on `depth.test.ts`.

The code moved between the intent's analysis and its commit (C1). PR #53 (CHG-0005, `41d7ce3`) merged thirty seconds before the intent was created and changed the three engine-side sites: `engine.ts:230`, `:660` and `:825` now call `this.track(this.onSessionExit(s))`, and `track` (`engine.ts:125-128`) settles a rejection silently so `close()` can await it. The three http.ts sites are unchanged: `http.ts:49` (`launchDeps`), `:588` (`POST /api/sessions`) and `:619` (`POST /api/sessions/<id>/message`) still run `void o.engine.onSessionExit(s)`. `onSessionExit` (`engine.ts:691-722`) still checks `closed` at entry only. So on main today the production path is still a crash, the engine path is a silent swallow, and neither stops touching the repo after close. This spec turns the intent into checkable requirements against that code.

## Requirements

R1. **`onSessionExit` never rejects.** The promise returned by `Engine.onSessionExit(session)` settles, resolved, for every input and every failure of the work it awaits: a `GitError` from `store.refresh(true)` or `headSha`, a synchronous throw from `jobs.list`/`jobs.update`/`registry.patch` on a closed registry, a `JSON.parse` failure in `readSessionDeploys`, an error thrown by `runPerChange`, `mirrorReview`, `recordDeploysForSession`, `mirrorProposal` or `recordBandSession`. Every existing call site keeps working unchanged: the three `track(...)` sites and the three `void` sites in http.ts are both correct once the callee cannot reject. Done signal: the test in R5(a) passes, and `grep -n "onSessionExit" packages/server/src` shows one definition plus the six call sites, none of which relies on its own catch.

R2. **Every caught failure is logged, once, with the error verbatim.** A rejection on the exit path produces exactly one line through `EngineOptions.log` (`engine.ts:34`; under `sdlc serve` that is stderr via `serve.ts:100` and `cli/src/commands/serve.ts:38`) of the form:

```
[engine] <changeId or triageId>: session <sessionId> exit not handled (<kind> <status>): <error.message>
```

`error.message` is included as is: a `GitError` message already carries git's own stderr (`git.ts:16`), and the principle is that evidence is literal (decisions principle 5). Nothing on the exit path swallows without logging; `track`'s swallow stays only because both promises it receives (`onSessionExit` after R1, `r.finished` from `observe`) no longer reject, and its comment says so (C3).

R3. **A closed engine stops at the next await and touches nothing afterwards.** In `onSessionExit` and the five helpers it awaits (`recordBandForSession` `engine.ts:245`, `recordDeploysForSession` `:725`, `mirrorForSession` `:746`, `fileProposalForSession` `:770`, `runForSession` `:792`), after every `await` the code re-checks `this.closed` before the next access to the repository (`store.refresh`, `readTree`, `headSha`, `commitWritePlan`), the registry or the job store, and before launching anything (`launchSession` at `:823`). On a closed engine the method returns (`null` for the helpers, `undefined` for `onSessionExit`) after one log line:

```
[engine] <changeId>: engine closed — session <sessionId> exit handling stopped before <step>
```

No `jobs.claim` happens after close. A job the helper claimed before the close and then abandoned is updated to `failed` with error `engine closed before <step>` (C4); a job whose underlying write already committed (the run file, the mirrored review, the deploy record) is updated `done` as today, because the file on disk is the truth and only the cache would otherwise disagree. Done signal: the test in R5(b).

R4. **Nothing else changes behaviour.** `Engine.close()` keeps the CHG-0005 contract (awaits the running pass, the sync in flight and every outstanding session and its exit handling; kills nothing). `track` is untouched apart from its comment. `serve.ts` shutdown ordering, `observer.ts`, `launcher.ts`, `packages/core` and `packages/server/test/depth.test.ts` are not edited (intent Constraints; C5, C6, C7). The `SUPERVISED` early return in the launcher (`launcher.ts:250-255`) still never reaches `onSessionExit`.

R5. **The defect is a test.** Two `it` blocks in `packages/server/test/` (D4), both deterministic, neither depending on suite load:
- (a) a finished build session whose repository has been removed: `engine.onSessionExit(session)` resolves, and the captured log has one line matching `/session sess-.* exit not handled \(build done\): git /`.
- (b) `engine.close()` called while `onSessionExit` is awaiting its first `store.refresh(true)`: the exit promise resolves, `close()` resolves, no `per-change-run` job was claimed, the default branch's head sha is unchanged, and the log has one line matching `/engine closed — session .* exit handling stopped before/`.
Removing the catch of D1 makes (a) reject; removing the post-await checks of D2 makes (b) claim a job and commit a run. That is the regression guard.

R6. **The suite is clean, twice, and the before is recorded.** The plan's first step runs `pnpm test` twice on `main` from an installed worktree and pastes the tail of both runs verbatim, so the ledger says whether "Errors 1 error" still reproduces after PR #53 (C2). After the change, `pnpm build`, `pnpm lint` and `pnpm test` twice are green with no "Errors" block and no unhandled-rejection line, pasted verbatim into the plan's Proof (CLAUDE.md Verifying your work; C12 on where that must run).

R7. **Scope.** Files that change: `packages/server/src/engine/engine.ts` and one test file under `packages/server/test/` (new or `engine.test.ts`). `packages/server/src/http.ts` needs no edit for R1; if the build edits it for readability the plan lists it first (C9). Commit message: `sdlc(server): engine session exit never rejects; a closed engine stops at the next await`.

## Design

D1. **One guarded entry point.** The body of `onSessionExit` becomes `private async handleSessionExit(session: StoredSession): Promise<void>`. The public method is the guard:

```ts
/** A session finished. Never rejects: a failure on the exit path is logged (R2), not raised — the launcher's onExit discards this promise. */
onSessionExit(session: StoredSession): Promise<void> {
  return this.handleSessionExit(session).catch((e: unknown) => {
    this.log(`${session.changeId || session.band?.triageId || "-"}: session ${session.id} exit not handled (${session.kind} ${session.status}): ${(e as Error).message}`);
  });
}
```

A synchronous throw inside `handleSessionExit` (a closed registry in `jobs.list()` at the first line) becomes a rejection of the async function and lands in the same catch, so the guard covers `engine.ts:694-699` as well as every await. The six call sites do not change: `track(this.onSessionExit(s))` still lets `close()` wait, and `void o.engine.onSessionExit(s)` in http.ts now discards a promise that cannot reject. The `.catch` is the fix for the production process; D2 is the fix for the closed engine.

D2. **The post-await check.** One private helper, used at every await boundary listed in R3:

```ts
/** True (and logged once) when the engine closed while a session's exit handling was in flight: stop before the next repo, registry or job access. */
private stoppedAfter(session: StoredSession, step: string): boolean {
  if (!this.closed) return false;
  this.log(`${session.changeId || session.band?.triageId || "-"}: engine closed — session ${session.id} exit handling stopped before ${step}`);
  return true;
}
```

Insertion points, one per await:
- `handleSessionExit`: after `await this.recordDeploysForSession(session)` (`:707`), step `dispatch`; the return value of the band/review/propose helpers is not awaited for anything else, so no check follows them.
- `recordBandForSession`, `recordDeploysForSession`, `mirrorForSession`, `fileProposalForSession`: after the leading `await this.opts.store.refresh(true)`, step `claim` (return `null` before `jobs.claim`); after the awaited write (`recordBandSession`, `recordDeploysForSession`, `mirrorReview`, `mirrorProposal`), the job update stays (the file is committed; the cache should say so) and the trailing `await this.opts.store.refresh(true)` is skipped when closed, step `refresh`.
- `runForSession`: after the leading refresh, step `claim`; after `headSha` (`:806`), step `claim`; after `runPerChange` (`:813`), the job update and `registry.patch` stay (the run file is on disk), and both the trailing refresh and the resume launch (`:818-833`) are skipped when closed, step `resume`. `runForSession` is also the manual path (`runForChange`, `sdlc run`), where `closed` is never true before the call, so the manual path is unchanged.
- A closed engine that finds a job it claimed and cannot finish (only possible if the close lands between `claim` and the awaited write) updates it `failed` with error `engine closed before <step>` in the helper's existing `catch` by throwing a plain `Error` with that message (C4).

The closed-engine log line is emitted at most once per session because the first check that fires returns and no later check runs.

D3. **Why the callee and not the callers.** Six sites in two files already disagree on how to discard the promise (`track` vs `void`), and CHG-0005 changed three of them a day ago. A never-rejecting `onSessionExit` is the only contract that makes both forms correct and survives the next caller; the http.ts sites need no change, and `track` needs no second catch. The lint does not flag `void` on a promise (C11), so the guarantee has to live in the method.

D4. **Tests (R5).** In `packages/server/test/engine.test.ts`, using its `seeded()` and `harness()` helpers, or in a new `packages/server/test/session-exit.test.ts` with the same helpers copied (the build decides; one file, listed in the plan):

```ts
function finishedBuild(dir: string, registry: SessionRegistry): StoredSession { /* CHG-0018 build session, status "done", worktreePath under dir, as depth.test.ts doneSession() */ }

it("a session exit whose repository is gone resolves and logs the git failure (CHG-0006)", async () => {
  const dir = await seeded();
  const lines: string[] = [];
  const { store, engine } = harness(dir, green, false, (l) => lines.push(l));
  await store.refresh();
  const session = finishedBuild(dir, registry);
  rmSync(dir, { recursive: true, force: true });
  await expect(engine.onSessionExit(session)).resolves.toBeUndefined();
  expect(lines.filter((l) => /exit not handled \(build done\): git /.test(l))).toHaveLength(1);
});

it("a closed engine stops a session exit at the next await and touches nothing (CHG-0006)", async () => {
  const dir = await seeded();
  const lines: string[] = [];
  const { store, engine, jobs } = harness(dir, green, false, (l) => lines.push(l));
  await store.refresh();
  const before = await headSha(dir, "HEAD");
  const original = store.refresh.bind(store);
  let closing: Promise<void> | null = null;
  vi.spyOn(store, "refresh").mockImplementation((force) => { closing ??= engine.close(); return original(force); });
  await expect(engine.onSessionExit(finishedBuild(dir, registry))).resolves.toBeUndefined();
  await closing;
  expect(jobs.list().filter((j) => j.kind === "per-change-run")).toEqual([]);
  expect(await headSha(dir, "HEAD")).toBe(before);
  expect(lines.filter((l) => /engine closed — session .* exit handling stopped before claim/.test(l))).toHaveLength(1);
});
```

`harness()` gains an optional fourth argument for `log` (a test-only helper). The first test's `afterEach` `rmRetry` already tolerates an absent directory (`force: true`). No new fixture, no change to `fake-claude.sh`, no timing sleep.

D5. **What stays as it is, and why.**
- `track()` keeps swallowing: after D1 nothing it receives can reject, and its job is to keep `close()` waiting, not to report. Its comment changes to say that (C3).
- `serve.ts:116-121` keeps closing the registry right after `void engine.close()` (CHG-0005's decision); with D1 the consequence is a logged line, not a crash (C5).
- `observer.ts:88-89` and `launcher.ts:266-292` are not touched: the same class of failure, outside the intent's scope, carried forward (C6).
- `engine.ts:95` and `serve.ts:150` keep `void this.tick()`: a rejecting pass is a separate defect, carried forward (C7).
- `depth.test.ts` is not edited (intent Constraints: the fix belongs in the engine). Its un-awaited `engine.close()` at line 84 and the 500 ms sleep at line 119 are left for the plan to reconsider only if the R6 before-run still shows the error after the fix.

D6. **Files, tests, proof.**
- Files that change: `packages/server/src/engine/engine.ts` (edit); `packages/server/test/engine.test.ts` (edit) or `packages/server/test/session-exit.test.ts` (new). `http.ts` only if the build chooses the explicit form (C9).
- Tests: the two `it`s of D4 (R5); every existing test unchanged.
- Proof for the plan: the R6 before-pair on `main` and after-pair on the task branch, verbatim; `pnpm build` and `pnpm lint` output; the two D4 tests red with D1's `.catch` or D2's checks removed (a local experiment, not committed) and green restored; the build session's own `round` event from an installed worktree (C12).

## Areas of concern

- **C1 — intent premise vs main (intent.md Problem/Affected systems; decisions preamble).** Owner: po. PR #53 landed thirty seconds before the intent and already wrapped the three engine.ts sites in `track()`; three `void` sites remain in http.ts, `track` swallows silently, and `closed` is still entry-only. The spec is written against the code as it is.
- **C2 — reproduction unverified (CLAUDE.md Verifying your work; intent Constraints).** Owner: eng. The intent's 2-of-3 observation predates PR #53, and this worktree has no node_modules. R6 makes the before-run part of the proof.
- **C3 — silent swallow vs "caught and logged" (intent Proposed outcome; principle 5).** Owner: tech_lead. `track` settles a rejection without a line. D1 logs with the error verbatim; `track` keeps its swallow for promises that no longer reject.
- **C4 — stopping mid-chain and job state (decisions 1.7, 2.4; principle 1; blueprint NFR Reliability).** Owner: tech_lead. Writes are atomic commits, so the repo is never partial. A job claimed and abandoned at close is marked `failed` with `engine closed before <step>`; a manual run stays possible under its own key.
- **C5 — serve shutdown closes the registry at once (decisions 1.6; CHG-0005 commit message).** Owner: tech_lead. Exit handling in flight at shutdown hits a closed SQLite handle; after D1 that is a log line. The ordering is not changed here.
- **C6 — observer and launcher have the same hole (intent scope; CLAUDE.md "do not change code outside a change").** Owner: po. `observer.ts:89` re-propagates a rejecting launcher `onExit` through `.finally`; `observer.ts:88` patches the registry synchronously inside the `exit` event. Out of scope unless the PO widens it.
- **C7 — `tick()` under `void` (intent scope; decisions 1.7).** Owner: po. `readTree` at `engine.ts:298` is outside every catch; a rejecting pass is unhandled from `engine.ts:95` and `serve.ts:150`. Not the session-exit chain; carried forward.
- **C8 — `kind: feature` on a bug fix (decisions 0.2, 2.7; test-freeze hook).** Owner: po. Under `fix` the regression test would be frozen behind a repro that is the test itself. The spec assumes `feature` stays.
- **C9 — plan-sync (FR-41).** Owner: eng. The plan lists `engine.ts` and one test file; `http.ts` only if edited; nothing under core, sessions, serve or depth.test.ts.
- **C10 — no org skills (spec front-matter `skills`).** Owner: tech_lead. `.claude/skills` does not exist; `skills` is `[]`, as on CHG-0002.
- **C11 — lint does not catch discarded promises (CLAUDE.md lint; "a mistake made twice").** Owner: tech_lead. `tseslint.configs.strict` is not type-aware, so `no-floating-promises` is off. Second discarded-promise change in a day; the guard is carried forward.
- **C12 — uninstalled session worktrees (decisions 1.4; CLAUDE.md verify).** Owner: eng. The build session's Stop-hook round is red for environment reasons unless the worktree is installed; R6's proof must come from an installed one.

## Open questions carried forward

- **Observer and launcher hardening (from C6).** One `.catch` on `observer.ts:89` (log through the registry's `error` field or a passed logger) and a try/catch around the launcher's `onExit` body would close the last unhandled path between a harness exit and the engine. Ride here (three more lines, two more files in the plan) or its own change: the PO decides at gate 2.
- **`tick()` guard (from C7).** `this.unsubscribe = opts.store.subscribe(() => void this.tick().catch((e) => this.log(...)))` and the same in `serve.ts:150`. Same decision as above.
- **Shutdown ordering (from C5).** Whether `serve.ts` should `await engine.close()` with a bound (say 5 s) before `registry.close()`, so a run that finished during shutdown records its job. CHG-0005 chose not to wait; a bounded wait is a different trade. Tech lead.
- **Lint or CLAUDE.md line (from C11).** Type-aware linting for `packages/server` only (`no-floating-promises` with `void` still allowed) versus one line under "Things to get right": "A promise handed to `void` must come from a method documented never to reject." Tech lead.
- **`kind` (from C8).** `feature` is assumed; a `fix` needs a repro strategy in the intent. PO.
- **Resolved here, recorded for the plan:** the guarantee lives in `onSessionExit` (D1, D3), not in six call sites; `track` and `close()` keep CHG-0005's semantics (D5); `depth.test.ts` is not edited (D5).

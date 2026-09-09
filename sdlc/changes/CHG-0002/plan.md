---
id: CHG-0002
artifact: plan
cycle: 1
spec_sha: 5e2d8fd2ea518578dcdb1c3bcce8c5f64bd525b6
rev: 2
accepted_by: dkapper01@gmail.com
accepted_at: 2026-09-09T18:39:29Z
acceptance_line: From one commit, `SDLC_CHANGE=CHG-0001 SDLC_SESSION=sess-launcher pnpm test` and `env -u SDLC_CHANGE -u SDLC_SESSION pnpm test` both exit 0; packages/hooks/test/hooks.test.ts has 10 passing `it`s (9 unchanged + 1 new) and exactly 1 `runHook(` occurrence; `git diff main --stat` lists that file only.
context_manifest: sha256:6f0ed3f6368d8babb42349140d5bade3083f3c7626bc6416da50aecae20e234e
schema: 1
---
# Plan: hooks tests fail inside a launched session — scrub the launcher env (from spec.md 5e2d8fd2)

One file changes. The hooks source is correct (decisions 1.4: `SDLC_CHANGE` wins over the branch); `packages/hooks/test/hooks.test.ts` is wrong because it calls `runHook` without an `env` and so inherits whatever the launcher exported. The fix passes an explicit env, scrubbed of the two launcher variables, through one wrapper, and adds one test that reproduces the 2026-09-09 failure in-process.

## Files that change
packages/hooks/test/hooks.test.ts

## Order of work

0. **Make the session worktree runnable before anything else.** The launcher creates worktrees without `node_modules` (spec C7; CHG-0001 seq 23 recorded `tsc: command not found`). From the worktree root run `pnpm install --frozen-lockfile` once. This writes nothing that git tracks (`node_modules` is ignored), so plan-sync is not involved. Do not skip this: the `verify-before-done` Stop hook runs `pnpm build`, `pnpm test`, `pnpm lint` in this worktree and R6 needs those to measure the code, not a missing binary.

1. **Reproduce red before touching the file.** Run, from the worktree root:
   ```
   SDLC_CHANGE=CHG-0001 SDLC_SESSION=sess-launcher pnpm vitest run packages/hooks/test/hooks.test.ts
   ```
   Expected: 6 of the 9 `it`s fail with `expected 0 to be 2` (test-freeze ×2, plan-sync, verify-before-done ×2, production-gate). Keep the output; it goes in the PR body as the "before". Then confirm `env -u SDLC_CHANGE -u SDLC_SESSION pnpm vitest run packages/hooks/test/hooks.test.ts` is 9/9 green. If the red run is not red, stop and report: the premise has changed.

2. **Widen the import (line 8).** Change
   ```ts
   import { installHooks, runHook, type HookInput } from "../src/index.js";
   ```
   to
   ```ts
   import { installHooks, runHook, type HookInput, type HookName, type RunHookOptions } from "../src/index.js";
   ```
   Both types are already exported from `packages/hooks/src/run.ts` through `index.ts` (`export * from "./run.js"`); no source edit.

3. **Add the scrub helper and the wrapper** as module-level declarations, placed directly after the `ledger` helper (after line 35) so every `describe` below can see them:
   ```ts
   /** The variables the console's launcher exports for the hooks (harness.ts:64). A test must not inherit them: the throwaway worktree's branch decides the change (CHG-0002). */
   const LAUNCHER_VARS = ["SDLC_CHANGE", "SDLC_SESSION"] as const;
   function scrubbed(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
     const out: Record<string, string | undefined> = { ...env };
     for (const k of LAUNCHER_VARS) delete out[k];
     return out;
   }
   /** Every hook call in this file goes through here; `opts.env` may override the scrub (used by the CHG-0002 regression test). */
   const hook = (name: HookName, input: HookInput, opts: RunHookOptions = {}) => runHook(name, input, { ...opts, env: opts.env ?? scrubbed() });
   ```
   The wrapper is the spec's D3 with the spread order swapped: `tsconfig.base.json` sets `exactOptionalPropertyTypes`, and spreading an options object whose `env` may be absent over a definite `env` can type `env` as possibly `undefined`, which that flag rejects for an optional property. Writing `env: opts.env ?? scrubbed()` last keeps `env` definite and is semantically identical (an explicit `opts.env` wins, otherwise the scrub). `NodeJS.ProcessEnv` resolves because the base tsconfig has `types: ["node"]`. The keys are deleted, not set to `""` (R3). Today both readers happen to treat `""` as absent (`changeIdFrom` regex-tests the value, `parseHookInput` trims and falls through), but deletion is the only form that is correct against every future reader, and it is what the spec requires.

4. **Rewrite the 25 call sites.** Replace every `await runHook(` with `await hook(` in the file (lines 41, 44, 53, 61, 65, 66, 70, 71, 81, 88, 92, 105, 116, 120, 126, 158, 162, 163, 164, 169, 170, 171, 172, 175, 182). Arguments stay byte-identical, including the `{ exec }` third argument on lines 105, 116, 120 and 126, which the wrapper spreads so `exec` still reaches `verifyBeforeDone`. After this step the only `runHook(` in the file is inside the wrapper on the line added in step 3. Check with:
   ```
   grep -n "runHook(" packages/hooks/test/hooks.test.ts
   ```
   Expected: exactly one line, the wrapper. Do not rename, reorder, skip or change the expectation of any existing `it` (R4).

5. **Add the regression test (R5, D4)** as the last `it` inside `describe("test-freeze (acceptance k)")`, after the "does nothing for non-edit tools" test (after line 72):
   ```ts
   it("ignores the launcher's SDLC_CHANGE and SDLC_SESSION when the test says so (CHG-0002)", async () => {
     const { wt } = await seededWorktree();
     const launched = { ...process.env, SDLC_CHANGE: "CHG-0001", SDLC_SESSION: "sess-launcher" };
     const r = await hook("test-freeze", edit(wt, "test/export/csv.test.ts"), { env: scrubbed(launched) });
     expect(r.exitCode).toBe(2);
     const last = JSON.parse(ledger(wt, "CHG-0018").at(-1) ?? "{}") as { event: string; actor: { session: string } };
     expect(last).toMatchObject({ event: "hook.blocked", actor: { session: "sess-t" } });
   });
   ```
   It never mutates `process.env`, so it is safe under Vitest's default parallel pool. `sess-t` comes from the harness input built by `edit()`; the seed has no `CHG-0001`, exactly the 2026-09-09 shape.

6. **Prove the guard bites (local experiment, not committed).** Comment out the `delete out[k]` line inside `scrubbed`, run `pnpm vitest run packages/hooks/test/hooks.test.ts`, and confirm the new `it` fails with `expected 0 to be 2`. Restore the line, run again, confirm 10/10 green. Paste both runs into the PR body.

7. **Run the R1 pair from the worktree root, same commit, and keep the output verbatim:**
   ```
   SDLC_CHANGE=CHG-0001 SDLC_SESSION=sess-launcher pnpm test
   env -u SDLC_CHANGE -u SDLC_SESSION pnpm test
   ```
   Both must exit 0 with the same pass count, one higher than `main`'s count for the file. Then `pnpm build` (the hooks tsconfig includes `test`, so `tsc -b` type-checks the edited file) and `pnpm lint` (zero warnings; `LAUNCHER_VARS`, `scrubbed` and `hook` are all used, so no unused-var finding).

8. **Commit once**, on the task branch, with exactly:
   ```
   sdlc(hooks): tests pass an explicit env to runHook, scrubbed of the launcher variables
   ```
   `git status` must show `packages/hooks/test/hooks.test.ts` as the only modified tracked file before `git commit`. plan-sync allows the commit because that path is the single entry under Files that change (C3). If plan-sync blocks, the diff has strayed; revert the stray file rather than editing this plan.

9. **Let the Stop hook run.** `verify-before-done` executes the three CLAUDE.md commands under the session env (`SDLC_CHANGE=CHG-0002`, `SDLC_SESSION=<build session>`). With step 0 done and steps 2–5 in place, the round it records is green; that `round` event on the CHG-0002 ledger is the R6 evidence. Do not run the commands with `env -u` in front of them anywhere in the build session: the point of the change is that no such prefix is needed.

## Risks

- **A future bare `runHook(` in this file regresses silently** (spec C5). Mitigation inside scope: the wrapper is the only sanctioned entry point and step 4's grep is the reviewer's check. The repository-wide lint rule is carried forward in the spec's open questions and is not part of this change.
- **`SDLC_HOME` is not scrubbed** (spec C4). Gate 2 was accepted by PR merge with no recorded decision on widening `LAUNCHER_VARS`, so this plan follows the intent and the spec's D2 as written: two variables. This repository is a single product and never sets `SDLC_HOME`, so the tests are green here. If the PO wants the third variable, the build adds the string `"SDLC_HOME"` to `LAUNCHER_VARS` in step 3 and nothing else in this plan moves; the plan-sync file list is unchanged either way.
- **The build session's worktree is uninstalled** (spec C7). Step 0 handles it for this change; the launcher-side fix is a separate change. If step 0 is skipped, the Stop hook records `command not found` rounds and R6 cannot be shown, even though the code is right.
- **`kind: feature` must stay** (spec C2). Under `kind: fix` with a committed repro, test-freeze would block every edit to `packages/**/test/**` including the very file this change edits. change.yaml says `feature` and `repro: null` today; the build must not change either.
- **`exactOptionalPropertyTypes`.** The spec's D3 spread order (`{ env: scrubbed(), ...opts }`) may fail `tsc -b` under that flag. Step 3 uses the order that is definitely well-typed; if the build finds the spec's order also compiles, either is acceptable, but the plan's form is the one to commit so the two match.
- **Vitest pool isolation.** The new test builds its env from a spread of `process.env` rather than mutating it, so it cannot leak into sibling tests whichever pool Vitest uses. Nothing in the plan calls `vi.stubEnv`.
- **Spec line references drift.** Line numbers in this plan are against `main` at spec acceptance (`hooks.test.ts` is 186 lines, 25 `runHook(` calls). If the file has moved, the grep in step 4 and the count of 25 are the invariants, not the line numbers.

## Proof

- **R1, both green from the same commit, output pasted verbatim in the PR body:** `SDLC_CHANGE=CHG-0001 SDLC_SESSION=sess-launcher pnpm test` and `env -u SDLC_CHANGE -u SDLC_SESSION pnpm test`, each exiting 0 with identical pass counts.
- **R3:** `grep -c "runHook(" packages/hooks/test/hooks.test.ts` prints `1` (the wrapper).
- **R4:** `git diff main -- packages/hooks/test/hooks.test.ts` shows no removed `it(` line and no changed `expect(` line; the only removed lines are the import line and the 25 `await runHook(` lines, each replaced in place.
- **R5:** the new `it` passes; the step 6 experiment shows it red with the `delete` removed and green with it restored (both runs pasted in the PR body).
- **R2:** `git diff main --stat` lists exactly one file; `packages/hooks/src/**` and `packages/hooks/test/index.test.ts` do not appear.
- **R6:** the CHG-0002 ledger carries a `round` event from the build session's `verify-before-done` with test green under `SDLC_CHANGE=CHG-0002`, and the session ends without a `hook.blocked` from `verify-before-done`.
- **Verification block:** `pnpm build`, `pnpm test`, `pnpm lint` all green in the build worktree, output pasted in the session's done report.

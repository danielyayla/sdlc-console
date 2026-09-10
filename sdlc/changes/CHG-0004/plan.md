---
id: CHG-0004
artifact: plan
cycle: 1
spec_sha: 750ffc571fc9631097d179427d3f73e8f05acad9
rev: 1
accepted_by: null
accepted_at: null
acceptance_line: ""
context_manifest: sha256:3211380310e586ae83020d58d18f1d0885eb5d296bf54961413973f0ee972315
schema: 1
---
# Plan: Root eslint ignores .sdlc-state session worktrees (from spec.md 750ffc57)

One file changes. `pnpm lint` is `eslint . --max-warnings 0`; ESLint descends into every directory the root config does not ignore, and a session worktree under `.sdlc-state/worktrees/` is a full checkout with its own `tsconfig.json`, which makes typescript-eslint refuse every file with "No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present". The fix is one entry in the existing `globalIgnores([...])` call (spec D1, D2). Nothing under `packages/`, `.gitignore`, `vitest.config.ts`, `package.json` or any `tsconfig*.json` is touched (spec R4, C3).

Two facts about the environment shape the order of work and the proof, and neither is derivable from the diff:

- The build session's worktree is created without `node_modules` (spec C4, CHG-0002 C7). In this plan session `ls node_modules/.bin/eslint` fails, so a bare `pnpm lint` falls through to whatever ESLint is on the PATH. Step 0 installs before anything is measured.
- A worktree holds no nested worktrees (its `.sdlc-state/` contains only `sessions/<id>/` with JSON files), so lint inside the build session never showed the failure and cannot show the fix. The R1 evidence comes from the root checkout at `/Users/danielkapper/Projects/sdlc-console`, run by the engineer (spec D5).

## Files that change
eslint.config.js

## Order of work

0. **Install the build worktree first.** From the worktree root run `pnpm install --frozen-lockfile` once. `node_modules` is gitignored, so plan-sync is not involved. Without this the `verify-before-done` Stop hook measures a missing or global binary, not the config; the spec session saw `pnpm lint` die with `ENOTDIR ... .git/**` under a global ESLint 8.24.0 for exactly this reason (spec C4). Confirm with `pnpm exec eslint --version`; expected `v10.9.1` (the lockfile pin, spec D4).

1. **Reproduce red from the root checkout before editing (engineer, not the session).** In a second terminal, from `/Users/danielkapper/Projects/sdlc-console` on its current branch, with at least one directory present under `.sdlc-state/worktrees/` (the build session's own worktree qualifies), run:
   ```
   ls .sdlc-state/worktrees
   pnpm lint 2>&1 | grep -c 'multiple candidate TSConfigRootDirs'
   pnpm exec eslint . --max-warnings 0 --ignore-pattern '.sdlc-state/**'; echo "exit $?"
   ```
   Expected: a non-empty listing; a count in the hundreds to low thousands (the intent measured about 1970; the number scales with how many worktrees exist and how many `.ts` files each holds); `exit 0` from the ignore-pattern variant. Keep the first two outputs; they are the "before" half of the PR body. If the count is 0 with a worktree present, stop and report: the premise has changed and the fix is not needed.

2. **Edit `eslint.config.js` (session).** Replace lines 13–14, which today read
   ```js
     // A change's design/ folder holds exports (a Claude Design page, its support script), not code that ships.
     globalIgnores(["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "fixtures/seed/**", "sdlc/changes/*/design/**"]),
   ```
   with
   ```js
     // A change's design/ folder holds exports (a Claude Design page, its support script), not code that ships.
     // .sdlc-state/ is the disposable cache (CLAUDE.md); session worktrees under it are full checkouts with their own tsconfig.json.
     globalIgnores([
       "**/dist/**",
       "**/node_modules/**",
       "**/*.tsbuildinfo",
       "fixtures/seed/**",
       "sdlc/changes/*/design/**",
       "**/.sdlc-state/**",
     ]),
   ```
   This is the spec's D2 block verbatim: the five existing patterns unchanged and in the same order, one new pattern `**/.sdlc-state/**` last, one new comment line naming why (spec R5). The leading `**/` matches how `dist/` and `node_modules/` are written and covers a product home under a subdirectory (spec C1; equivalent to `.sdlc-state/**` in this single-product repository). No new import: `globalIgnores` is already imported from `eslint/config` on line 3. Do not reformat any other line of the file; the diff is one comment line plus the array reflowed onto one entry per line.

3. **Verify inside the build worktree (session).** From the worktree root run `pnpm build`, `pnpm test`, `pnpm lint`; all three must exit 0 with output. `pnpm lint` here is the R2 proxy: this checkout has a `.sdlc-state/` (only `sessions/`), no nested worktree, and no CI job runs lint (see Risks), so a green lint here shows the new pattern is well-formed and does not over-match. Also run `pnpm exec eslint --print-config eslint.config.js | head -3` and confirm it prints a config object, not `undefined`: that proves the root config file itself is not swallowed by the new ignore.

4. **Commit (session).** On the task branch `CHG-0004/<slug>`, stage `eslint.config.js` alone and commit with exactly:
   ```
   sdlc(lint): root eslint ignores .sdlc-state (session worktrees carry their own tsconfig)
   ```
   `git diff main --stat` must list `eslint.config.js` only (the change's ledger under `sdlc/changes/CHG-0004/` is exempt from plan-sync and may also appear). Then `report_done` with the three command outputs from step 3 verbatim.

5. **Prove R1 and R3 from the root checkout (engineer).** With the task branch pushed or visible locally and the root checkout clean (`git status --porcelain` empty), from `/Users/danielkapper/Projects/sdlc-console`:
   ```
   git switch --detach CHG-0004/<slug>
   ls .sdlc-state/worktrees
   pnpm lint; echo "exit $?"
   pnpm lint 2>&1 | grep -c 'multiple candidate TSConfigRootDirs'
   pnpm exec eslint .sdlc-state/worktrees/sdlc__CHG-0004__plan/eslint.config.js
   git switch -
   ```
   Expected, in order: a non-empty listing; `pnpm lint` prints nothing and `exit 0`; the grep prints `0`; the explicit-file lint prints ESLint's own "File ignored because of a matching ignore pattern" warning for that path (the deterministic R3 signal: ESLint names the file as ignored rather than parsing it; pick any worktree name from the listing if that one is gone). `git switch --detach` is used because the task branch is checked out in the build worktree and git refuses a non-detached checkout of it. If the root tree is not clean, do not switch; instead run `git show CHG-0004/<slug>:eslint.config.js > eslint.config.js`, the same four commands, then `git checkout -- eslint.config.js`. Paste every line of this block's output, verbatim, into the PR body under a "Proof" heading next to the step-1 "before" output.

6. **Open the PR and stop.** Title as the commit subject; body carries the before (step 1) and after (step 5) outputs and the step-3 round. Gate 3 (the plan) and gate 4 (the PR merge) are the engineer's; the session never accepts or merges.

## Risks

- **The spec's R2 done signal does not exist.** Spec R2 names "`pnpm lint` green in the CI run that GitHub reports on the PR". The four workflows under `.github/workflows/` run `pnpm exec tsc -b` and `sdlc validate` (sdlc-validate.yml), the detect, evals and production-gate jobs; none runs `pnpm lint`. R2 is therefore proven by step 3 (an installed worktree with a `.sdlc-state/` but no nested worktree, the closest thing to the runner's state) and by the negative half of step 5 (the rule set is unchanged, only the walk narrowed). Adding a lint step to CI is a `.github/` change and outside R4; carried to the tech lead as a follow-up, not done here.
- **Uninstalled session worktree.** If step 0 is skipped, the Stop hook's round is red for `command not found` or a global ESLint 8, and `report_done` blocks on an environment failure that says nothing about this change (spec C4). The tech lead has agreed the root-checkout evidence is the done signal for R1; step 0 exists so the session's own round can still be green.
- **`--debug` grep from spec R3 is not the primary proof.** ESLint's debug log may print ignored directories while enumerating, so a non-zero `grep -c '\.sdlc-state/'` would be ambiguous. Step 5 uses the explicit-file lint instead: ESLint reports a matching ignore pattern by name, which is unambiguous. The debug grep may be run additionally; if it is non-zero, inspect the lines and confirm none is a "Linting" or "Processing" line for a path under `.sdlc-state/`.
- **Dotfile matching.** The fix relies on flat config matching ignore patterns with `dot: true`. ESLint's default `**/.git/` ignore and the existing `**/node_modules/**` rely on the same behaviour, so this is a documented property, not an assumption; step 5's grep returning `0` is the check. If it does not, the pattern is wrong, not the environment: re-read the D2 block, do not add a second spelling.
- **Scope creep.** Anything beyond the two lines is outside the spec: no `--ignore-pattern` in the `lint` script, no `includeIgnoreFile` from `@eslint/compat`, no `.gitignore` edit, no `tsconfig` or `parserOptions` change. plan-sync blocks a commit that touches any other tracked file; the ledger under `sdlc/changes/` is exempt.
- **Root checkout state.** Step 5 switches the engineer's checkout to a detached head briefly. The plan requires a clean tree first and gives the `git show` fallback; either path leaves the checkout exactly as found.

## Proof

Tests: none added (spec C2, D5). The existing suite is unaffected: `pnpm build` uses project references, `pnpm test` includes `packages/**/test/**` and `fixtures/test/**` only (spec D3).

Evidence, all pasted verbatim (CLAUDE.md non-negotiable):

1. Before (root checkout, step 1): `ls .sdlc-state/worktrees` non-empty; `pnpm lint 2>&1 | grep -c 'multiple candidate TSConfigRootDirs'` greater than 0.
2. Session round (build worktree, step 3): `pnpm build`, `pnpm test`, `pnpm lint` each exit 0 with output; `pnpm exec eslint --version` is `v10.9.1`.
3. After (root checkout, step 5): `ls .sdlc-state/worktrees` non-empty; `pnpm lint` exit 0 with no findings (R1); the grep count is `0`; `pnpm exec eslint .sdlc-state/worktrees/<name>/eslint.config.js` prints "File ignored because of a matching ignore pattern" (R3).
4. Diff: `git diff main --stat` on the PR head lists `eslint.config.js` only, 8 insertions and 1 deletion (the reflowed array), commit subject exactly `sdlc(lint): root eslint ignores .sdlc-state (session worktrees carry their own tsconfig)` (R4).

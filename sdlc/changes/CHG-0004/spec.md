---
id: CHG-0004
artifact: spec
cycle: 1
intent_sha: 95fb80d588cb29b4408a57d6dfddb483bb8f103b
prompt_ref: prompts/design-pass@1
skills: []
concerns:
  - id: C1
    policy: intent.md Constraints (keep the fix to the globalIgnores list; ignore `.sdlc-state/` the same way `dist/` and `node_modules/` are) and docs/decisions.md 1.6 / 3.2 (every worktree and every product home carries its own `.sdlc-state/`)
    owner: tech_lead
    resolved: false
    note: The intent names the root directory `.sdlc-state/`; the two siblings it cites are written `**/dist/**` and `**/node_modules/**`. The spec chooses `**/.sdlc-state/**` (D2) so a product home under a subdirectory (decisions 3.2, `products[].path` other than `.`) is covered by the same line. For this single-product repository both spellings behave identically. The tech lead confirms the `**/` form is the intended reading of "the same way dist/ and node_modules/ already are".
  - id: C2
    policy: CLAUDE.md Conventions (fixture repos are the test oracle) and Non-negotiables (evidence is command output shown verbatim, never summarised); docs/decisions.md 1.4 (the round carries verbatim output)
    owner: tech_lead
    resolved: false
    note: "No Vitest test can exercise the root ESLint config: the suite includes `packages/**/test/**` and `fixtures/test/**` only, and a test that runs `eslint .` against a checkout containing a nested worktree would take longer than the whole suite. The proof is therefore the R1 command run from the root checkout with at least one session worktree present under `.sdlc-state/worktrees/`, its output pasted verbatim into the plan's Proof (D5). The tech lead accepts command evidence in place of a test for this change."
  - id: C3
    policy: 'plan-sync hook (.claude/hooks/plan-sync.sh, packages/hooks/src/plan-sync.ts, FR-41, decisions 0.6): every committed file must be listed under plan.md "Files that change"; intent Affected users and systems: `eslint.config.js` (root) only, no package code changes'
    owner: eng
    resolved: false
    note: The plan lists exactly `eslint.config.js`. No file under `packages/`, no `.gitignore`, no `vitest.config.ts`, no `tsconfig*.json` changes (R4). A build session that finds itself editing anything else has left the spec.
  - id: C4
    policy: docs/decisions.md 1.4 (verify-before-done runs the CLAUDE.md verification commands itself under the session and blocks unless the round is green) and CLAUDE.md Verifying your work (build, test, lint all green before reporting done)
    owner: tech_lead
    resolved: false
    note: "Two things make the build session's own Stop-hook round unreliable as the done signal for this change. First, the session worktree is not installed: in this spec session `pnpm lint` fell through to a globally installed ESLint 8.24.0 and died with `ENOTDIR: not a directory, stat '.../.git/**'` because a worktree's `.git` is a file, a red that says nothing about the config (the same launcher gap CHG-0002 carried forward). Second, a worktree contains no nested worktrees, so lint inside one was never red for the intent's reason and cannot show the fix. The done signal for R1 must therefore come from the root checkout (D5); the tech lead decides whether the build session's round may be recorded red for the environment reason while the PR carries the root-checkout evidence."
  - id: C5
    policy: "docs/decisions.md 0.2 (`kind: feature|fix`) and 2.7 (repro-first fix flow: a fix freezes the test globs behind a committed repro); change.yaml has `kind: fix` and `repro: null`"
    owner: po
    resolved: false
    note: "The change is a fix without a test-shaped repro, because a lint-config failure has no test that can reproduce it (C2). test-freeze does not bite: it only blocks while a repro test is committed, and `eslint.config.js` is outside every test glob. The reproduction is the pair of commands in the intent (red `pnpm lint`, green with `--ignore-pattern '.sdlc-state/**'`), which R1 turns into the done signal. The PO owns kind and repro (MCP tools never edit them, decisions 1.5) and confirms `fix` with `repro: null` is acceptable here."
  - id: C6
    policy: spec front-matter `skills` (packages/schemas/src/frontmatter.ts:44) and the task's instruction to apply the org skills under .claude/skills
    owner: tech_lead
    resolved: false
    note: This worktree has no `.claude/skills` directory (only `.claude/hooks` and `.claude/settings.json`), so no org skill was applied and `skills` is `[]`. Same finding as CHG-0002 C8; if a skill is expected to shape specs it is missing from the repository, not skipped by this session.
created: 2026-09-10T10:30:22Z
context_manifest: sha256:5a168d4679016f48cceb32d373bbd8c459da873d82b25da2afff18f409a554c7
schema: 1
---
# Spec: Root eslint ignores .sdlc-state session worktrees

The intent (accepted at gate 1, sha `95fb80d5`) describes one failure: `pnpm lint` is `eslint . --max-warnings 0`, ESLint walks the whole checkout, and once the engine has created a session worktree under `.sdlc-state/worktrees/` (decisions 1.6) the walk enters a second full checkout with its own `tsconfig.json`. typescript-eslint then sees several candidate roots and refuses every file with "Parsing error: No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present", about 1970 times. `pnpm exec eslint . --max-warnings 0 --ignore-pattern '.sdlc-state/**'` is clean from the same checkout, which pins the cause to the walk, not to any package. This spec turns that into checkable requirements, fixes the one-line design, and names the file, the proof and the concerns the plan must carry.

## Requirements

R1. **Lint is green with worktrees present.** From the root checkout, with at least one directory under `.sdlc-state/worktrees/` that contains a `tsconfig.json`, `pnpm lint` exits 0 with zero warnings. Done signal, pasted verbatim into the plan's Proof (C2, C4):

```
ls .sdlc-state/worktrees
pnpm lint
```

The first command proves a worktree was present; the second proves lint ignored it.

R2. **Lint is unchanged without worktrees.** From a root checkout with no `.sdlc-state/` directory at all, `pnpm lint` reports the same result as before this change. An ignore pattern for a directory that does not exist is a no-op in ESLint flat config; this requirement guards against a pattern that is malformed or over-broad. Done signal: `pnpm lint` green on the change branch in the CI run that GitHub reports on the PR (the runner has no `.sdlc-state/`).

R3. **Nothing in the cache is ever linted.** No file under any `.sdlc-state/` directory is a lint target from the root, regardless of what the engine writes there: session files (`sessions/<id>/*.json*`), the SQLite cache, snapshots or nested worktrees (decisions 1.5, 1.6, 3.2, 3.4). Done signal: `pnpm exec eslint --debug . 2>&1 | grep -c '\.sdlc-state/'` is 0 from a checkout with a worktree present, or equivalently R1 with a worktree that carries `.ts` sources in every package.

R4. **One file, one commit.** The change touches `eslint.config.js` only. `package.json`'s `lint` script, `.gitignore`, `vitest.config.ts` and every `tsconfig*.json` are untouched (C3). The plan lists that path alone under Files that change. Commit message: `sdlc(lint): root eslint ignores .sdlc-state (session worktrees carry their own tsconfig)`.

R5. **The reason travels with the line.** The new pattern carries a one-line comment naming why the directory is ignored (intent Constraints), so the next reader does not remove it as a leftover.

## Design

D1. **Where the fix lives, and where it does not.** The fix is one entry in the existing `globalIgnores([...])` call in `eslint.config.js`. It is not a package change: no package's `tsconfig.json` or `parserOptions` is wrong, and no package is involved in the failure. It is not a `lint` script change: `--ignore-pattern` on the command line would fix `pnpm lint` but not an editor's ESLint integration or any other `eslint .` invocation, and the config is where the sibling ignores already live. It is not `includeIgnoreFile` from `@eslint/compat` reading `.gitignore`: that would unify the two lists but adds a dependency and widens the ignore set to `*.log`, `.DS_Store` and `.eslintcache`, beyond what the intent asked for (carried as an open question).

D2. **The pattern.** The first config entry becomes:

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

`**/.sdlc-state/**` rather than `.sdlc-state/**` (C1): the intent asks for the directory to be ignored "the same way `dist/` and `node_modules/` already are", and those are written with a leading `**/`. Decisions 3.2 gives each product home its own `.sdlc-state/`, so a future product under a subdirectory is covered by the same line. In this repository the product path is `.`, and the two spellings are equivalent today. ESLint flat config matches ignore patterns with `dot: true`, so the leading dot in the directory name needs no special handling (the existing `**/node_modules/**` and ESLint's own default `.git/` ignore rely on the same behaviour). Ordering inside the array carries no meaning; the entry goes last so the diff is one added line plus one comment line.

D3. **Why only lint is affected.** `pnpm build` uses `tsconfig.json` project references, an explicit list of twelve `tsconfig.build.json` files, and never globs. `pnpm test` includes `packages/**/test/**/*.test.{ts,tsx}` and `fixtures/test/**/*.test.ts`, both anchored at the repository root, so a nested checkout under `.sdlc-state/worktrees/` is never reached. Only `eslint .` starts from the root and descends into every directory not ignored. That is why the intent scopes the fix to `eslint.config.js` and why R4 forbids touching the other two configs.

D4. **What the ESLint version allows.** The lockfile pins `eslint@10.9.1` and `typescript-eslint@8.69.0`. `globalIgnores` from `eslint/config` is the supported way to declare ignores in flat config at that version and is already in use; no new import is needed.

D5. **Files, tests, proof.**
- Files that change: `eslint.config.js` (edit; two lines added, nothing removed).
- Tests: none added (C2). The existing suite is unaffected (D3).
- Proof for the plan: the R1 pair of commands run from the root checkout while a session worktree exists, pasted verbatim; the R2 CI status on the PR head; optionally the R3 grep count. Because the build session's worktree is not installed and contains no nested worktree, its own Stop-hook round cannot produce the R1 evidence (C4); the engineer runs R1 from the root checkout and pastes it.

## Areas of concern

- **C1 — intent Constraints ("the same way `dist/` and `node_modules/` already are") and decisions 1.6 / 3.2 (a `.sdlc-state/` per worktree and per product home).** Owner: tech_lead. The intent writes `.sdlc-state/`; the siblings it cites are `**/dist/**` and `**/node_modules/**`. D2 uses `**/.sdlc-state/**` so a subdirectory product home is covered too. Equivalent for this repository; the tech lead confirms the reading.
- **C2 — CLAUDE.md Conventions (fixture repos are the test oracle) and Non-negotiables (evidence verbatim).** Owner: tech_lead. No Vitest test can exercise the root ESLint config. Proof is the R1 commands from the root checkout with a worktree present, pasted verbatim into the plan.
- **C3 — plan-sync (FR-41): every committed file is in the plan; intent: `eslint.config.js` only.** Owner: eng. The plan lists `eslint.config.js` alone. `.gitignore`, `vitest.config.ts`, `package.json` and every `tsconfig*.json` stay untouched.
- **C4 — decisions 1.4 (verify-before-done runs the verification commands under the session) and CLAUDE.md Verifying your work.** Owner: tech_lead. The session worktree is uninstalled: this spec session's `pnpm lint` fell through to a global ESLint 8.24.0 and died with `ENOTDIR ... .git/**`, a red about the environment (the CHG-0002 launcher gap). A worktree also holds no nested worktree, so lint inside it never showed the intent's failure. The done signal must come from the root checkout (D5); the tech lead decides how a red environment round on the build session is treated.
- **C5 — decisions 0.2 (`kind: fix`) and 2.7 (repro-first fix flow); `repro: null` in change.yaml.** Owner: po. A lint-config failure has no test-shaped repro; the intent's command pair is the reproduction and R1 is its done signal. test-freeze does not bite (no repro committed, `eslint.config.js` outside the test globs). The PO confirms `fix` with `repro: null` is acceptable.
- **C6 — spec front-matter `skills` and the instruction to apply `.claude/skills`.** Owner: tech_lead. The worktree has no `.claude/skills` directory, so no org skill was applied and `skills` is empty. Same finding as CHG-0002 C8.

## Open questions carried forward

- **Two lists that name the same directory (from D1).** `.gitignore` (written by `sdlc init`, decisions 0.8) and `eslint.config.js` now both say `.sdlc-state`. `includeIgnoreFile` from `@eslint/compat` would derive one from the other at the cost of a dependency and a wider ignore set. The tech lead decides whether that unification is worth its own change; this one keeps the intent's explicit line.
- **Should the console notice this class of drift? (from C1, D3).** `sdlc init` writes `.sdlc-state/` into `.gitignore` and never touches other files (decisions 0.8). A doctor-style check that warns when the root lint config does not ignore `.sdlc-state/` would have caught this before the first session did. A `packages/cli` change; carried for the tech lead.
- **Uninstalled session worktrees (from C4, carried from CHG-0002).** The launcher creates a worktree without `node_modules`, so `verify-before-done` runs `pnpm lint` against a global ESLint that cannot even stat a worktree's `.git` file. This change does not touch it; it stays a launcher change in `packages/server` and should become its own change so the Stop hook's round is reliable in every launched session.
- **Resolved here, recorded for the plan:** the fix is a config entry, not a `lint` script flag, not a package `tsconfig` change and not a `.gitignore`-derived ignore (D1); the pattern is `**/.sdlc-state/**` pending C1; no test is added and the proof is command output (D5).

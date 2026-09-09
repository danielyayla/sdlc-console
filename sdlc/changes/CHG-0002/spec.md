---
id: CHG-0002
artifact: spec
cycle: 1
intent_sha: 6a7c445cd1839416f5eb1088f459d9800b654aac
prompt_ref: prompts/design-pass@1
skills: []
concerns:
  - id: C1
    policy: CLAUDE.md Verifying your work — never skip or delete a failing test; if a test fails, fix the code, not the test
    owner: tech_lead
    resolved: false
    note: "This change edits the failing tests and leaves the source alone. The justification: the hooks source behaves as decisions 1.4 and 1.4→e2e specify (SDLC_CHANGE wins over the branch), and the tests are wrong because they rely on the ambient process env instead of stating the env they need. No `it` block is removed or weakened; every assertion keeps its expected exit code and ledger line, and one `it` is added. The tech lead should confirm this reading before the plan is accepted."
  - id: C2
    policy: "docs/decisions.md 0.2 (`kind: feature|fix`) and the repro-first fix flow (decisions 2.7, `sdlc change new --kind fix`): a fix freezes the test globs behind a committed repro; MCP tools never edit kind (decisions 1.5)"
    owner: po
    resolved: false
    note: "change.yaml says `kind: feature` on purpose (intent Constraints): the only file that changes is packages/hooks/test/hooks.test.ts, which the test-freeze hook would block under `kind: fix` until a repro is committed, and the repro would be the very file being edited. The PO owns kind and risk; the spec assumes `feature` stays. If the PO prefers `fix`, the intent must come back with a repro strategy that does not need the frozen file."
  - id: C3
    policy: 'plan-sync hook (FR-41, .claude/hooks/plan-sync.sh, decisions 0.6): every committed file must be listed under plan.md "Files that change"; intent Constraints: one file'
    owner: eng
    resolved: false
    note: The plan lists exactly `packages/hooks/test/hooks.test.ts`. `packages/hooks/test/index.test.ts` (where line 16 asserts SDLC_CHANGE wins over the branch) and every file under packages/hooks/src stay untouched; a build session that finds itself editing anything else has left the spec.
  - id: C4
    policy: 'intent.md Proposed outcome and Constraints — scope is "the process env minus the two launcher variables"; docs/decisions.md 3.2 (monorepo products: `SDLC_HOME` set by the launcher, read by `homeFor`)'
    owner: po
    resolved: false
    note: The launcher sets a third variable, SDLC_HOME, when a session is launched for a product directory (packages/server/src/sessions/launcher.ts:171); `homeFor` resolves it against the repository root, so inside such a session the same test would resolve its throwaway worktree to a path that does not exist and fail open. This repository is a single product, so SDLC_HOME is unset here today and the intent's two variables are sufficient for it. R3 follows the intent (two variables). The spec proposes adding SDLC_HOME to the scrub list as one extra key in the same line (D2); the PO decides whether that widening rides here or waits.
  - id: C5
    policy: docs/decisions.md 1.4 and 1.4→e2e — hooks resolve the change from SDLC_CHANGE first, then the `CHG-NNNN/*` branch; running without either allows silently; intent Constraints (do not change how changeIdFrom or parseHookInput read the launcher env)
    owner: tech_lead
    resolved: false
    note: "The spec answers the intent's first open question with no: `runHook` keeps `process.env` as its default and does not scrub when the cwd is on a change branch, because a band or product session relies on the env and a source change would break the one-file constraint. The cost is that any future test that calls `runHook` without `env` regresses the same way; D3's wrapper and R5's regression test guard hooks.test.ts only. Carried forward as a lint question (Open questions)."
  - id: C6
    policy: docs/decisions.md 1.4 — verify-before-done runs the CLAUDE.md verification commands itself under the session; CLAUDE.md Non-negotiables — evidence is shown verbatim, never summarised
    owner: tech_lead
    resolved: false
    note: "The spec answers the intent's second open question with no: packages/hooks/src/verify-before-done.ts:19 keeps spreading `process.env` (plus CI=1, FORCE_COLOR=0) into the commands it runs. Unsetting SDLC_CHANGE and SDLC_SESSION there would hide this class of bug in every other package's tests and would make the hook's round differ from what the engineer's shell sees. The round the hook records stays a faithful measurement of the suite under the launcher env, which is what R1 makes green."
  - id: C7
    policy: intent.md Proposed outcome — "`pnpm test` is green inside a launched session"; CLAUDE.md Verifying your work — build, test and lint all green before reporting done
    owner: po
    resolved: false
    note: "A session worktree that was never `pnpm install`ed is still red inside a launched session for a different reason (CHG-0001 ledger seq 23: `tsc: command not found`, `vitest: command not found`). This change removes the env cause only; the Proposed outcome holds for an installed worktree. The uninstalled-worktree cause belongs to the launcher and is a separate change (Open questions). The PO should read the intent's outcome with that qualifier."
  - id: C8
    policy: spec front-matter `skills` (packages/schemas/src/frontmatter.ts:44) and the task's instruction to apply the org skills under .claude/skills
    owner: tech_lead
    resolved: false
    note: This worktree has no `.claude/skills` directory (only `.claude/hooks` and `.claude/settings.json`), so no org skill was applied and `skills` is `[]`. If the organisation expects a skill to shape specs (a test-writing or TypeScript skill, say), it is missing from the repository, not skipped by this session.
created: 2026-09-09T18:31:33Z
context_manifest: sha256:731c3159ddc32b9cda9f7a630c27f7a496bbfa3c7bf1d01b51555899ab8e7563
schema: 1
---
# Spec: hooks tests fail inside a launched session — scrub the launcher env

The intent (accepted at gate 1, sha `6a7c445c`) describes one failure: `packages/hooks/test/hooks.test.ts` calls `runHook` without an `env`, `runHook` falls back to `process.env`, and inside a session the console launched that env carries `SDLC_CHANGE` and `SDLC_SESSION`. `changeIdFrom` in `packages/hooks/src/context.ts:15` prefers `SDLC_CHANGE` over the task branch, so the throwaway worktrees on `CHG-0018/export-fix` and `CHG-0017/export` are judged as the session's change (CHG-0001 on 2026-09-09), the seed has no such change, `hookContext` returns null, and every hook that should block allows. Six of the nine hook tests exit 0 where they expect 2 (CHG-0001 ledger seq 58 and 60). This spec turns that into checkable requirements, decides the two open questions the intent carried, and names the single file, the tests and the done signals the plan must carry.

## Requirements

R1. **Environment independence.** `pnpm test` is green with `SDLC_CHANGE` and `SDLC_SESSION` exported (as the launcher exports them, `packages/server/src/sessions/harness.ts:64`) and green with them unset, from the same commit, with no `env -u` in front of it. Done signal, both green from the same worktree, output pasted verbatim into the plan's Proof:

```
SDLC_CHANGE=CHG-0001 SDLC_SESSION=sess-launcher pnpm test
env -u SDLC_CHANGE -u SDLC_SESSION pnpm test
```

R2. **The hooks keep honouring the launcher.** No file under `packages/hooks/src` changes. `changeIdFrom` still returns `SDLC_CHANGE` when it names a change, `parseHookInput` still takes `SDLC_SESSION` over the harness's `session_id`, `homeFor` still reads `SDLC_HOME`, and `runHook` still defaults `opts.env` to `process.env`. `packages/hooks/test/index.test.ts` is untouched and its line 16 assertion (`changeIdFrom("main", { SDLC_CHANGE: "CHG-0020" })` is `CHG-0020`) keeps passing.

R3. **The test states its env.** Every `runHook` call in `packages/hooks/test/hooks.test.ts` receives an explicit `env` that is the process env with `SDLC_CHANGE` and `SDLC_SESSION` absent (the keys deleted, not set to the empty string). The rest of the process env passes through unchanged so `PATH`, `HOME` and git's identity variables reach the hook. Done signal: the file has no `runHook(` call without an `env`; concretely, the only bare `runHook(` in the file is inside the wrapper D3 introduces.

R4. **Every existing assertion survives unchanged.** The nine existing `it` blocks keep their names, their expected exit codes, their expected `reason` substrings and their expected ledger lines. In particular the six that failed on 2026-09-09 (test-freeze ×2, plan-sync, verify-before-done ×2, production-gate) go back to expecting exit 2 for the same inputs without any change to the expectation. No `it` is skipped, deleted or loosened (C1).

R5. **The incident is a test.** One new `it` in `hooks.test.ts` reproduces the launcher case without touching `process.env`: it passes the wrapper an env that contains `SDLC_CHANGE: "CHG-0001"` and `SDLC_SESSION: "sess-launcher"` (an id the seed does not have, exactly as on 2026-09-09), runs `test-freeze` on an edit to `test/export/csv.test.ts` in a `CHG-0018/export-fix` worktree, and expects exit 2 and a `hook.blocked` line on `sdlc/changes/CHG-0018/log.jsonl` whose actor session is `sess-t` (the harness input's id), not `sess-launcher`. This test fails on today's `main` if the scrub is removed and passes with it, which is the regression guard for R3.

R6. **The Stop hook measures the code.** In a build session for this change, the `verify-before-done` round runs `pnpm test` under the session env (`SDLC_CHANGE=CHG-0002`) and records test green. The round's `outputExcerpt` in the CHG-0002 ledger is the evidence, verbatim (CLAUDE.md Non-negotiables); the plan's Proof cites the `round` event.

R7. **One file, one commit.** The change touches `packages/hooks/test/hooks.test.ts` only. The plan lists that path alone under Files that change, so `plan-sync` allows the commit (C3). The commit message follows the convention: `sdlc(hooks): tests pass an explicit env to runHook, scrubbed of the launcher variables`.

## Design

D1. **Where the fix lives, and where it does not.** The fix is in the test because the source is correct by decisions 1.4 and 1.4→e2e: a band session or a product-directory session has no `CHG-NNNN/*` branch and must find its change in the env. `runHook` already exposes `opts.env` (`packages/hooks/src/run.ts:21`) for exactly this seam; the test never used it. Nothing in `packages/core`, the CLI, the server, the MCP server or the web console is involved.

D2. **The scrub.** One module-level helper in `hooks.test.ts`:

```ts
const LAUNCHER_VARS = ["SDLC_CHANGE", "SDLC_SESSION"] as const;
function scrubbed(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of LAUNCHER_VARS) delete out[k];
  return out;
}
```

`LAUNCHER_VARS` holds the two variables the intent names. C4 proposes adding `SDLC_HOME` to that list; if the PO takes it, the change is one string in this line and nothing else in the spec moves. Only `SDLC_CHANGE` changes a hook's outcome today; `SDLC_SESSION` is removed so a future read of it inside a hook cannot regress the suite the same way, and the intent asked for both.

D3. **The wrapper.** Every hook call in the file goes through one local function that supplies the scrubbed env and lets the caller add the other options the tests already use (`exec` for verify-before-done):

```ts
const hook = (name: HookName, input: HookInput, opts: RunHookOptions = {}) => runHook(name, input, { env: scrubbed(), ...opts });
```

The 25 existing `await runHook(` call sites become `await hook(`; the arguments are otherwise identical. `HookName` and `RunHookOptions` are already exported from `../src/index.js` via `run.ts`; the import line gains those two types. The wrapper is the single place a future test author has to look, and the R3 done signal (no bare `runHook(` outside the wrapper) is what a reviewer greps for.

D4. **The regression test (R5).** Added to the `test-freeze (acceptance k)` describe block, since test-freeze is the first hook the ledger showed failing and needs no `exec` seam:

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

It passes `scrubbed(launched)` explicitly rather than mutating `process.env`, so it is safe under any Vitest pool and proves the scrub, not the ambient shell. Removing the `delete` in D2 makes this test exit 0 and fail, which is the 2026-09-09 failure reproduced in-process.

D5. **What stays as it is, and why.** Both of the intent's open questions are answered no in this cycle:
- `runHook` does not default to a scrubbed env when the cwd is on a change branch. It is a source change (breaks the one-file constraint), it would invert decisions 1.4's precedence for one caller only, and a session launched for a product directory legitimately runs on a branch that names a change while `SDLC_HOME` points elsewhere (C5).
- `verify-before-done` does not unset the two variables for the commands it runs (`verify-before-done.ts:19`). The hook's round must measure the suite as the session sees it; scrubbing there would hide this class of bug in every other package (C6).

D6. **Files, tests, proof.**
- Files that change: `packages/hooks/test/hooks.test.ts` (edit; no new files).
- Tests: the nine existing hook `it`s unchanged in expectation (R4), plus one new `it` (R5). The suite count rises by one.
- Proof for the plan: the two R1 commands green from the same commit, pasted verbatim; the R5 test red when the `delete` in D2 is commented out and green with it restored (a one-line local experiment, not committed); the CHG-0002 build session's own `round` event with test green under `SDLC_CHANGE=CHG-0002` (R6).

## Areas of concern

- **C1 — CLAUDE.md "Verifying your work": fix the code, not the test.** Owner: tech_lead. This change edits the failing tests and leaves the source alone, on the reading that the tests are wrong (they depend on the ambient env) and the source is right (decisions 1.4). R4 keeps every assertion; R5 adds one. The tech lead confirms the reading.
- **C2 — decisions 0.2 `kind: feature|fix` and the repro-first fix flow (2.7).** Owner: po. `kind: feature` is deliberate: a `fix` freezes `packages/**/test/**` behind a repro, and the repro would be the file being edited. MCP tools cannot change kind (decisions 1.5); the PO can. The spec assumes `feature`.
- **C3 — plan-sync (FR-41): every committed file is in the plan.** Owner: eng. The plan lists `packages/hooks/test/hooks.test.ts` only. `index.test.ts` and `packages/hooks/src/**` stay untouched.
- **C4 — intent scope: "the two launcher variables"; decisions 3.2 `SDLC_HOME`.** Owner: po. The launcher also sets `SDLC_HOME` for product-directory sessions (`launcher.ts:171`), and it would break the same test the same way in a monorepo. This repository is a single product, so the intent's two variables suffice here. D2 follows the intent; adding `SDLC_HOME` is one string in `LAUNCHER_VARS`, and the PO decides whether it rides now.
- **C5 — decisions 1.4 / 1.4→e2e: env-first change resolution; intent constraint on `changeIdFrom`.** Owner: tech_lead. The spec keeps `runHook`'s `process.env` default. Any future test that calls `runHook` bare can regress; D3's wrapper and R5 guard this file only. A lint question is carried forward.
- **C6 — decisions 1.4: verify-before-done runs the verification commands itself; evidence verbatim.** Owner: tech_lead. `verify-before-done.ts:19` keeps spreading `process.env`. The round stays a faithful measurement of the suite under the launcher env, which R1 makes green.
- **C7 — intent Proposed outcome: "`pnpm test` is green inside a launched session".** Owner: po. An uninstalled session worktree is still red for a different reason (`tsc: command not found`, CHG-0001 seq 23). This change removes the env cause only; the outcome holds for an installed worktree. The launcher-side fix is a separate change.
- **C8 — spec front-matter `skills` and the instruction to apply `.claude/skills`.** Owner: tech_lead. The worktree has no `.claude/skills` directory, so no org skill was applied and `skills` is empty. If one is expected, it is missing from the repository.

## Open questions carried forward

- **Guarding the seam across the repository (from C5).** Should an ESLint rule (or a Vitest setup file) forbid calling `runHook` without `env` under `packages/**/test/**`, so the next test author cannot recreate this failure? Not in scope here (one file, no config change); the tech lead decides whether it becomes its own change.
- **`SDLC_HOME` (from C4).** Whether the scrub list grows to three variables now or when a monorepo repository first hits it. Decided by the PO at gate 2; either answer is a one-string edit to D2.
- **Uninstalled session worktrees (from C7).** The launcher creates a worktree without `node_modules`, so `verify-before-done` runs `pnpm build`/`test`/`lint` against missing binaries and records red rounds that say nothing about the code (CHG-0001 seq 23). That is a launcher change in `packages/server`, out of scope here; it should become its own change so the Stop hook's round is reliable in every launched session.
- **Round provenance.** Whether a `round` event should record the `SDLC_*` variables the commands ran under, so a future red round caused by the environment is diagnosable from the ledger without a session note. A schema and hook change; carried for the tech lead.
- **Resolved here, recorded for the plan:** `runHook` does not default to a scrubbed env on a change branch, and `verify-before-done` does not unset the launcher variables (D5). Both stay as source behaviour; this change is test-only.

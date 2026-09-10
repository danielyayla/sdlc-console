---
id: CHG-0007
artifact: spec
cycle: 1
intent_sha: da96a60afc6b876e42e82669884ce6a8b584c12b
prompt_ref: prompts/design-pass@1
skills: []
concerns:
  - id: C1
    policy: CLAUDE.md Non-negotiables — evidence (command output) is shown verbatim, never summarised; docs/decisions.md principle 5; decisions Q10 (evidence in git ≤ 1 MB per file); decision 1.4 (rounds keep verbatim tails)
    owner: tech_lead
    resolved: false
    note: The full install output lives on the session record and in .sdlc-state/sessions/<id>/install.log (disposable). The ledger's session.started event carries manager, command, exit code and a verbatim tail (outputExcerpt, same rule as round.results[].outputExcerpt) rather than the whole output, because a pnpm install prints kilobytes and the ledger union-merges across branches. Decide whether the tail is acceptable on the ledger or the whole output must be committed.
  - id: C2
    policy: CLAUDE.md Conventions — schemas live in packages/schemas and generate types and MCP tool schemas; docs/decisions.md 0.2 (zod is the source, committed JSON must not drift; session.started is a strictObject)
    owner: eng
    resolved: false
    note: session.started gains an optional install field, so packages/schemas/src/event.ts and the generated packages/schemas/json/event.schema.json both change and the drift test must be regenerated, not edited. Seed fixtures and every existing ledger stay valid because the field is optional.
  - id: C3
    policy: "docs/decisions.md principle 10 (local-first: everything works against a local clone with no network first); intent.md Constraints — offline first, prefer the package manager's store"
    owner: tech_lead
    resolved: false
    note: "The launcher runs the package manager found on PATH with --prefer-offline / --frozen-lockfile and never enables corepack. package.json declares packageManager: pnpm@10.12.4; if the PATH pnpm differs and corepack is active on the machine, corepack may try to download that version, which needs the network. The spec accepts this as the operator's environment (the same as running pnpm build by hand) and records whatever happens verbatim. Confirm that the console must not enable or pin the manager itself."
  - id: C4
    policy: CLAUDE.md Verifying your work — build, test and lint green; pnpm 10 skips dependency build scripts unless allowlisted (no onlyBuiltDependencies in package.json or pnpm-workspace.yaml)
    owner: eng
    resolved: false
    note: packages/server depends on better-sqlite3 (native). A by-hand pnpm install in a worktree produced a green 553-test run (CHG-0002 build session sess-vyed6rf8nq, round 1), so the install works on this machine; the pnpm version on PATH could not be read from the design session's sandbox. The build must prove the frozen offline install yields a loadable better-sqlite3 in a fresh worktree (R12) before relying on it.
  - id: C5
    policy: CLAUDE.md Non-negotiables — packages/core has no I/O; docs/decisions.md principle 12 and 0.1 (core may depend only on @sdlc/ packages, no Node builtins)
    owner: eng
    resolved: false
    note: installFromLockfile reads the filesystem (existsSync), so it cannot move to core. It moves to packages/server/src/sessions/install.ts and the CLI imports it from @sdlc/server (the CLI already depends on @sdlc/server). No I/O enters core.
  - id: C6
    policy: docs/decisions.md 1.7 (session exit → per-change run in the same worktree) and 1.6 (SUPERVISED sessions are prepared, not spawned); intent.md Affected users — every session kind and the SUPERVISED handover
    owner: eng
    resolved: false
    note: "The install belongs to worktree preparation, shared by launchSession and launchBandSession, and runs on every launch (new checkout, reused checkout, resume), not only when addWorktree ran: engine.fetchBranch creates review worktrees before launchSession sees them, and a reused task worktree may have a moved lockfile. A resumed session whose install now fails is refused like a fresh one. Confirm that always-run (the manager's own no-op is the skip) is the intended reading of the intent's first open question."
  - id: C7
    policy: "sdlc/config.yaml thresholds.autoFilesMax: 12 (AUTO eligibility, decisions principle 9); docs/decisions.md preamble (decisions made during build get a row)"
    owner: eng
    resolved: false
    note: The file list in Design is 12 without a docs/decisions.md row and 13 with it. The plan decides whether the decisions row rides in this change (SUPERVISED build) or the change stays at 12 files (AUTO-eligible) and the row is added by a person on merge.
  - id: C8
    policy: CLAUDE.md Things to get right — no bypass or force path on any gate or hook; intent.md Open questions — opt-out or override in sdlc/config.yaml
    owner: po
    resolved: false
    note: This change adds no config key, env flag or CLI option to skip or replace the install; the lockfile alone decides and the absence of a lockfile is the only no-install case. A LaunchDeps.exec seam exists for tests only. Carried forward as an open question; confirm no opt-out is wanted in this change.
  - id: C9
    policy: "CLAUDE.md Verifying your work — run build, test and lint before reporting done; memory: session worktrees are never installed, the fix belongs in the launcher"
    owner: eng
    resolved: false
    note: The launcher that starts this change's own plan and build sessions is the console already running from main, so those sessions still start in an uninstalled worktree; a person runs pnpm install there by hand once more, as for CHG-0001 and CHG-0002. The intent's done signal (first verify-before-done round green) is observable only for the first session launched after this change is merged and the console restarted; R11 tests 2 and 3 and the manual R12 check are the proof inside the change.
created: 2026-09-10T10:35:13Z
context_manifest: sha256:0c232b13887031f72c38a8dda41440faf5d346f019806b42896e39decf2fda31
schema: 1
---
# Spec: Session worktrees start without dependencies — the launcher installs them

The launcher (`packages/server/src/sessions/launcher.ts`) and the band launcher (`packages/server/src/maintain/session.ts`) add a git worktree and spawn or hand over a harness in it, but never install the project's dependencies there. Every plan session on this repository so far ended with a red verify-before-done round whose only cause was the bare worktree (CHG-0001 sess-p64xc9q5nw; CHG-0002 sess-56x5yea3ry, ledger seq 19: `sh: tsc: command not found`, `sh: vitest: command not found`, and a global ESLint 8 crashing on `.git/**`). This spec makes the install a step of worktree preparation, recorded as evidence on the session, and turns the intent's outcome into checkable requirements.

## Requirements

R1. **Install after the worktree, before the harness.** For every session `launchSession` and `launchBandSession` start (kinds intent, design, plan, build, review, diagnose, propose; modes AUTO, PLAN, HEADLESS, SUPERVISED; fresh launches and `resume` relaunches), the project's dependencies are installed at the *checkout root* of the worktree (`worktreePathFor(root, branch)`, not the product prefix inside it) after the worktree exists and before the per-session `mcp.json`, prompt and session record are written. The step runs whether or not `addWorktree` ran in this launch (a checkout created earlier by `engine.fetchBranch`, a reused task worktree, a resume) and whether or not `node_modules` already exists (C6).

R2. **The lockfile picks the manager; no lockfile, no step.** The manager is `installFromLockfile(checkout)`: `pnpm-lock.yaml` → pnpm, `package-lock.json` or `npm-shrinkwrap.json` → npm, `yarn.lock` → yarn, else `null`. The rule has one definition, in `packages/server/src/sessions/install.ts`, and `sdlc init` imports it from `@sdlc/server` so the CI workflows and the launcher cannot disagree (C5). With `null` nothing runs, nothing is recorded except `install: null` on the session, and the launch continues without an error or a note.

R3. **Commands are fixed, frozen and offline-first.** The command per manager is:

| manager | command |
|---|---|
| pnpm | `pnpm install --frozen-lockfile --prefer-offline` |
| npm | `npm ci --prefer-offline --no-audit --no-fund` |
| yarn | `yarn install --immutable` |

It runs through `sh -c` with `cwd` = the checkout root, the launcher's `env` plus `CI=1` and `FORCE_COLOR=0` (the same shape as `engine/runner.ts`), stdout and stderr captured together, and a timeout of 10 minutes (`SDLC_INSTALL_TIMEOUT_MS` overrides). The console does not enable corepack, pin a manager version, add registry flags or pass a caller's string (C3). No repository configuration, environment flag or CLI option changes or skips the command (C8).

R4. **Success is recorded verbatim on the session.** `StoredSession` gains `install: { manager: "pnpm"|"npm"|"yarn"; command: string; exitCode: number; startedAt: string; durationMs: number; output: string } | null`. `output` is the complete captured output, untruncated. The same output is also written to `<worktree>/.sdlc-state/sessions/<id>/install.log` beside `prompt.md` (disposable cache, decision 1.6). The OTel session span gets attributes `sdlc.install.manager`, `sdlc.install.exit_code`, `sdlc.install.duration_ms` and one span event `sdlc.install` (3.3).

R5. **The ledger carries the install as evidence.** `session.started.data` gains an optional `install: { manager, command, exitCode, outputExcerpt }` where `outputExcerpt` is the verbatim tail of the output, limited the same way `round.results[].outputExcerpt` is (C1, C2). Band sessions have no change ledger (decision 3.4) and record the install on the session record and span only.

R6. **A failed install stops the launch with its output.** When the exit code is not 0 (including a timeout, recorded as exit code `-1` with `timed out after <n> ms` appended to the output), the launcher throws `ActionError(502, "dependency install failed in <checkout>: <command> exited <code>", diagnostics, retryable: true)` where the single diagnostic's message is the complete output verbatim. No session record is created, no `session.started` is committed, no harness is spawned, no engineer command is handed over. The worktree and branch stay in place so the next launch retries the same install. Through HTTP the body is `{error, diagnostics, retryable: true}` (decision 1.1); the CLI prints the message and the output on stderr and exits 1; an engine job that launched the session fails with the same message and the output in its `error`, so the Jobs list on the Sessions view shows it.

R7. **The output is shown, never summarised.** The Sessions view adds, when a row is expanded and `install` is not null, one detail row `install` reading `<manager> · exit <code> · <duration in seconds>` and, under it, the full `output` in the existing evidence element (`<pre>` mono 12, `white-space: pre-wrap`, max-height 220 with scroll), untruncated. The row is green when exit is 0. Sessions with `install: null` show nothing.

R8. **SUPERVISED is prepared the same way.** A SUPERVISED launch runs the install before returning `awaiting_engineer` and the engineer command; the record carries `install` like any other, so the person's terminal opens in a worktree that can already run `pnpm build`.

R9. **Nothing else about the launch changes.** Branch naming, `worktree prune`, the base branch choice, `mcp.json`, prompt, `allowedTools`, permission mode, the `session.started`/`session.stopped` commits, the observer, the capacity ceiling and every existing precondition keep their order and behaviour. `packages/core`, `packages/mcp`, `packages/hooks` and `CLAUDE.md`/`.claude/**` are untouched. The install is an environment step; it edits nothing under `sdlc/` beyond the ledger event in R5.

R10. **Test seam.** `LaunchDeps` and `BandLaunchDeps` gain `exec?: Exec` (the `Exec` type from `engine/runner.ts`: `(cmd, cwd) => Promise<{exitCode, output}>`), used only by the install; tests inject it. No production caller passes it.

R11. **Tests.** (1) `packages/server/test/install.test.ts`: `installFromLockfile` on a directory with each lockfile and with none; `installDependencies` returns `null` without a lockfile, runs the exact R3 command for each manager through a fake `exec` and returns `{manager, command, exitCode, output, …}`; the log file is written; a fake exit 2 comes back with its output intact. (2) `sessions.test.ts`: a seeded repository with a `pnpm-lock.yaml` committed and a fake `exec` → the record's `install` matches `{manager: "pnpm", exitCode: 0}`, `install.log` exists in the session directory, `session.started.data.install` on the branch has `manager`, `command`, `exitCode: 0` and an `outputExcerpt`, and the fake harness still runs to `done`. (3) The same with a fake `exec` returning exit 1 and output `ERR_PNPM_OUTDATED_LOCKFILE` → `launchSession` rejects with status 502, `retryable: true`, the output in `diagnostics[0].message`, the registry has no record, the branch's ledger has no `session.started`, and the worktree still exists; a second launch with a passing `exec` succeeds. (4) A seeded repository without any lockfile (the existing tests) launches exactly as today and the record has `install: null`. (5) `maintain.test.ts`: a band session with a lockfile and a fake `exec` records `install` on the session. (6) `packages/cli` init tests keep passing with `installFromLockfile` imported from `@sdlc/server`. (7) `packages/web/test/render.test.tsx`: a session with `install: {exitCode: 0, output: "Lockfile is up to date\nDone in 1.2s"}` renders the `install` row and the output text verbatim; a session with `install: null` renders no `install` row. (8) The schema drift test passes after `event.schema.json` is regenerated.

R12. **Done signals.** `pnpm build`, `pnpm test`, `pnpm lint` green with output pasted. Manual proof on this repository, output pasted into the round: `sdlc session start CHG-0007 --kind plan --mode SUPERVISED` (or the equivalent against a scratch change) from the built console prints a record whose `install.exitCode` is 0, and `node -e "require('better-sqlite3')"` plus `pnpm -s exec tsc --version` succeed inside that worktree (C4). The intent's own signal, a green first verify-before-done round of a plan session, is checked on the first session launched after merge (C9).

## Design

The change is one new server module, a shared worktree-preparation step used by both launchers, one optional field on the session record and on the `session.started` event, and one detail row in the Sessions view. It has five parts: the install module, the shared preparation, records and schema, the failure path, and the view; then the order of work and the file list the plan inherits.

### The install module
`packages/server/src/sessions/install.ts` exports:
- `type InstallStep = "pnpm" | "npm" | "yarn" | null` and `installFromLockfile(dir): InstallStep` (moved from `packages/cli/src/commands/init.ts`, body unchanged). `packages/cli/src/workflows.ts` keeps its `InstallStep` import path by importing the type from `@sdlc/server` too, or `init.ts` re-exports it; the plan picks the smaller diff.
- `INSTALL_COMMANDS: Record<Exclude<InstallStep, null>, string>` holding the three R3 strings.
- `installDependencies(checkout, opts: { exec?: Exec; env?; now?; timeoutMs?; logFile?: string }): Promise<InstallRecord | null>` where `InstallRecord` is the R4 shape. Without `exec` it runs `sh -c` via `execFile` as `engine/runner.ts` does (the plan may lift `shell()` from the runner into a shared helper; either way the runner's behaviour is unchanged). It writes `logFile` when given and never throws on a non-zero exit; it throws only when the manager binary cannot be spawned, and that error message is the record's output with exit code `-1`.
- `installExcerpt(output): string` for the ledger tail, reusing the excerpt rule the hooks package applies to rounds.

### Worktree preparation, shared
The block that both launchers duplicate (mkdir `.sdlc-state/worktrees`, `worktree prune`, base choice, `addWorktree`) moves into `prepareWorktree(root, branch, { defaultBranch, exec?, env?, now?, timeoutMs? })` in `install.ts` (or a sibling `worktree.ts`), returning `{ checkout, created: boolean, install: InstallRecord | null }`. `launchSession` calls it where lines 163–170 are today, then `mkdirSync(stateDir)`, then writes `install.log` from the record (the session id is chosen after preparation, so the helper returns the output and the launcher writes the file). On `install.exitCode !== 0` it throws the R6 error before `deps.registry.upsert`. `launchBandSession` does the same at its lines 102–107. The adapter's `addWorktree` stays as it is; the install is not the git adapter's concern.

### Records and schema
- `registry.ts`: `StoredSession.install?: InstallRecord | null` (optional so cached records from before this change still parse; `enrich` leaves it alone). The launcher sets it explicitly on every new record.
- `event.ts`: `session.started.data.install` optional strict object `{ manager: z.enum(["pnpm","npm","yarn"]), command: nonEmpty, exitCode: z.number().int(), outputExcerpt: z.string() }`; regenerate `packages/schemas/json/event.schema.json` (C2).
- Span: attributes and event per R4, alongside the existing `sdlc.session.*` attributes.

### Failure path
R6 uses the existing `ActionError` (`status 502`, `retryable`) so `http.ts` line 230 already serialises it; the CLI `session start` already maps `ActionError` to a `CliError`, and the plan verifies the diagnostic message reaches stderr untruncated. The engine's `launchSession` callers (engine.ts 658, 823) already record a thrown error on the job; the plan confirms the job store's `error` column is not shortened and, if it is, widens it rather than trimming the output.

### View
`Sessions.tsx`: extend `SessionCard` with `install?: {manager; command; exitCode; durationMs; output} | null`; push one `details` entry `{k: "install", v: "pnpm · exit 0 · 3.2 s", cls: exitCode === 0 ? "green-text" : "red-text"}`; render the output after the details grid in the existing evidence `<pre>` styling (no new utility class). No new callbacks, routes or snapshot fields beyond the record already flowing through `snapshot.sessions`.

### Order of work and files
1. `install.ts` + `install.test.ts`; move `installFromLockfile`, update `init.ts` import, run cli tests.
2. Schema field + regenerated JSON + drift test.
3. `prepareWorktree` in `launcher.ts` and `maintain/session.ts`; registry field; span attributes; `sessions.test.ts` and `maintain.test.ts` cases.
4. `Sessions.tsx` + render test.
5. `docs/decisions.md` row if C7 says so.

Files that change: `packages/server/src/sessions/install.ts` (new), `packages/server/src/sessions/launcher.ts`, `packages/server/src/maintain/session.ts`, `packages/server/src/sessions/registry.ts`, `packages/server/src/index.ts`, `packages/cli/src/commands/init.ts`, `packages/schemas/src/event.ts`, `packages/schemas/json/event.schema.json`, `packages/web/src/views/Sessions.tsx`, `packages/server/test/install.test.ts` (new), `packages/server/test/sessions.test.ts`, `packages/web/test/render.test.tsx` — 12; `docs/decisions.md` would be the 13th (C7). `maintain.test.ts` case 5 rides only if the count allows; otherwise the shared helper's coverage in `sessions.test.ts` stands for it. Commit messages `sdlc(server): …`, `sdlc(schemas): …`, `sdlc(web): …`, `sdlc(cli): …`.

### Out of scope
A config opt-out or command override (C8, carried forward); enabling corepack or pinning the manager (C3); installing inside temporary worktrees used only for commits (`withBranchWorktree`) or the console's own checkout; changing what verify-before-done or the per-change run execute; any change to `packages/core`, hooks, MCP tools, `CLAUDE.md` or `.claude/**`.

## Areas of concern
Each concern is carried in the front-matter as `{id, policy, owner, resolved: false}`; none is resolved here.

- **C1 · install output on the ledger is a verbatim tail, not the whole output** — policy: CLAUDE.md non-negotiable "evidence shown verbatim, never summarised", decisions principle 5, Q10 (evidence size), decision 1.4 (rounds keep verbatim tails). Owner: tech_lead. Whole output on the record and in `install.log`; the `session.started` event carries `outputExcerpt`. Decide whether the tail is acceptable in git.
- **C2 · `session.started` schema change** — policy: CLAUDE.md Conventions (schemas generate types), decision 0.2 (JSON drift test). Owner: eng. Optional field, regenerated JSON, fixtures untouched.
- **C3 · package manager on PATH, corepack not enabled** — policy: decisions principle 10 (local-first, no network), intent constraint "offline first". Owner: tech_lead. `packageManager: pnpm@10.12.4` and an active corepack could fetch the manager; the console records whatever happens and does not manage the manager.
- **C4 · native module under a frozen offline install** — policy: CLAUDE.md "Verifying your work" (test green); pnpm 10 build-script policy with no allowlist in the repo. Owner: eng. Proven by hand for CHG-0002; the pnpm version on PATH was not readable from the design sandbox; R12 proves it in a fresh worktree.
- **C5 · `installFromLockfile` does I/O** — policy: CLAUDE.md non-negotiable "core has no I/O", decisions 12 and 0.1. Owner: eng. It moves to `@sdlc/server`, not core.
- **C6 · install on every launch, not only on `addWorktree`** — policy: decisions 1.7 (the run uses the same worktree), 1.6 (SUPERVISED prepared), intent "every session kind and the SUPERVISED handover". Owner: eng. Answers the intent's first open question with "always run"; confirm.
- **C7 · 12 or 13 files** — policy: `thresholds.autoFilesMax: 12`, decisions preamble (a decision row). Owner: eng. The plan chooses AUTO-eligible without the row, or SUPERVISED with it.
- **C8 · no opt-out or override** — policy: CLAUDE.md "no bypass or force path", intent's second open question. Owner: po. Nothing skips or replaces the install; only the lockfile decides.
- **C9 · this change's own sessions still start bare** — policy: CLAUDE.md "Verifying your work"; the launcher in use is the merged console, not this branch. Owner: eng. One more by-hand `pnpm install` in the plan and build worktrees; the intent's done signal is observed on the first post-merge session.

## Open questions carried forward
- From intent: whether the install should be skipped when `node_modules` already exists. This spec runs it every launch and lets the manager's own no-op be the skip (C6); the owner may flip this to "only when the checkout was created" in the plan.
- From intent: whether a repository can opt out or override the command in `sdlc/config.yaml`. Not in this change (C8). A harness image that already carries dependencies makes the frozen install a fast no-op, so nothing is blocked by the absence of an opt-out; if a team needs one later it is a config key with its own schema change.
- Yarn classic (1.x) does not accept `--immutable`; the R3 command mirrors the workflow `sdlc init` writes. Whether yarn 1 repositories need `--frozen-lockfile` is decided when one appears; no such repository is in reach today.
- Whether `docs/decisions.md` gets its row in this change or on merge (C7).
- Whether the engine should retry a retryable install failure once (as it retries the first red run with an automatic resume) or leave it to the person. This spec leaves it to the person: the job fails with the output and the Sessions view shows it.

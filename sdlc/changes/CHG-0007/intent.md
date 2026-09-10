---
id: CHG-0007
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-10T10:26:21Z
status: draft
schema: 1
---
# Intent: Session worktrees start without dependencies — the launcher installs them

## Problem
The launcher creates a fresh git worktree for every session (`addWorktree` in `packages/server/src/sessions/launcher.ts`) and never installs the project's dependencies into it. A worktree is a bare checkout: no `node_modules`, no workspace links, no `.bin`. Every verification command in `CLAUDE.md` then fails with "command not found" (`tsc`, `vitest`) or falls through to whatever global tool happens to be on the machine (here a global ESLint 8 that crashes on `.git/**`).

This has hit every plan session so far. CHG-0001's plan session (sess-p64xc9q5nw, 2026-09-09T13:50Z) and CHG-0002's (sess-56x5yea3ry, 2026-09-09T18:35Z) both ended with a red verify-before-done round whose only cause was the uninstalled worktree; both agents diagnosed it, noted it in the ledger and could not fix it, because `pnpm install`, a symlink to the checkout's `node_modules` and `Write` were all denied by the session permissions. The build sessions of both changes only verified because a person ran `pnpm install` in the worktree by hand before the session started. The red rounds are recorded on the change as evidence and count toward the loop's "stalled" state, so an environment gap reads as the agent failing.

## Proposed outcome
A session's worktree is ready to run the verification contract the moment the harness starts. After the launcher adds the worktree and before it spawns (or hands over) the session, the project's dependencies are installed there, using the package manager the lockfile names — the same `installFromLockfile` rule `sdlc init` already applies when it writes the CI workflows — and the install's exit code and output are recorded verbatim on the session. A failed install stops the launch with that output instead of starting a session that cannot verify. Repositories without a lockfile get no install step and no error. The first verify-before-done round of a plan session on this repository is green for build, test and lint.

## Affected users and systems
- Every session kind the launcher starts (design, plan, build, review, diagnose, propose) and the SUPERVISED handover, whose worktree is prepared the same way.
- `packages/server/src/sessions/launcher.ts`; the `@sdlc/adapter-git` worktree helper if the install belongs beside `addWorktree`; `packages/cli/src/commands/init.ts` if `installFromLockfile` moves somewhere both can import it.
- The session record and its ledger events, which gain the install as evidence.
- The Sessions view, if the install output is shown.

## Constraints
- The console never calls a model and never edits `CLAUDE.md` or `.claude/**`; the install is an environment step, not a change to the contract.
- Output is shown verbatim, never summarised (decisions.md principle 5).
- Offline first: prefer the package manager's store (`--prefer-offline`, frozen lockfile); a clean install must not need the network when the checkout has one.
- `packages/core` stays free of I/O; the install lives in the server or the adapter.
- pnpm workspaces: installing at the worktree root is what links the workspace packages; installing inside one package is not enough.

## Open questions
- Whether the install should be skipped when a `node_modules` already exists in the worktree (a reused task worktree), or always run to honour the lockfile.
- Whether a repository can opt out or override the command in `sdlc/config.yaml` (for example a team whose harness image already carries dependencies).

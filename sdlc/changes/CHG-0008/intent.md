---
id: CHG-0008
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-10T10:34:51Z
status: draft
schema: 1
---
# Intent: Hosted-mode sync fast-forwards main without requiring it checked out

## Problem
Every hosted-mode pass that brings `origin/main` into the local default branch first calls
`requireOnBase` (`packages/server/src/github/artifacts.ts`), which refuses with
`hosted mode merges into main; the working tree is on <branch>` whenever the root working tree
is on anything but `main`. The engine runs that pass on every tick, so a developer who checks a
task branch out in the project root sees the 409 as a persistent error in the UI and the console
stops recording merges done on the host and stops syncing records until they switch back.
The check exists only because `mergeRemoteBranch` runs `git merge` in the root working tree,
which needs the branch checked out. A fast-forward of a ref does not.

## Proposed outcome
When the root working tree is on the default branch, nothing changes: `git merge --ff-only`,
then a merge commit if needed, as today. When it is on another branch, the pass fast-forwards
the ref directly with `git fetch origin main:main`. When that is refused (local lifecycle
commits origin lacks, or `main` checked out in another worktree) the merge runs in the worktree
that has `main` checked out, or in a temporary one, via the existing `withBranchWorktree`.
The `requireOnBase` guard and its 409 go away for the three hosted-mode sites: gate accept
through a PR, merged-PR detection, and records sync. The local-mode gate 5 merge in
`actions.ts` keeps its own check: it merges a task branch into `main` in place.

## Affected users and systems
- `packages/adapters/git/src/remote.ts`: a `fastForwardBranch` helper.
- `packages/server/src/github/artifacts.ts`: `acceptViaPr`, `detectMergedPrs`, `syncRecords`.
- `packages/server/test/github.test.ts`: coverage for the root on a task branch, both the
  fast-forward and the non-fast-forward path.
- Anyone running the console with the project root on a task branch.

## Constraints
- Never force-update the default branch: `main:main` without `+`, so a non-fast-forward is
  refused by git and handled by a real merge, never by discarding local commits.
- The console snapshot still derives from the root's `HEAD` (decision 1.1); this change makes
  the engine's sync succeed, it does not make the console display `main` while the root is
  elsewhere.
- No accept, merge or approve capability is added to any agent-facing surface.

## Open questions
None.

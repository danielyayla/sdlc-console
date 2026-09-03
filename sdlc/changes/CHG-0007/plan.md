---
id: CHG-0007
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Against a real temporary git repo: readTree returns blob shas equal to git hash-object; commitWritePlan produces one commit with the actor as author and SDLC-* trailers; two branches appending to log.jsonl merge without conflict after installMergeUnion; worktree add/list/remove and diffFiles work; build/test/lint green"
schema: 1
---
# Plan: Git adapter, build-order item 0.7 (from spec.md n/a)

## Files that change
packages/adapters/git/src/index.ts
packages/adapters/git/src/git.ts (new)
packages/adapters/git/src/sha.ts (new)
packages/adapters/git/src/ids.ts (new)
packages/adapters/git/src/tree.ts (new)
packages/adapters/git/src/commit.ts (new)
packages/adapters/git/src/worktree.ts (new)
packages/adapters/git/src/ledger.ts (new)
packages/adapters/git/src/attributes.ts (new)
packages/adapters/git/test/index.test.ts
packages/adapters/git/test/helpers.ts (new)
packages/adapters/git/test/adapter.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. git.ts: `git(cwd, args, {input?})` over execFile, typed result, `GitError` with stderr; identity, head, branch, isRepo, init.
2. sha.ts: `blobSha(content)` = git's hash-object (sha1 over `blob <len>\0`), so core's write-plans can carry real shas; ids.ts: ULID factory.
3. tree.ts: `readTree(dir, ref, {prefixes})` via `git ls-tree -r -z` + `git cat-file --batch`; `readWorkingTree(dir, {prefixes})` from the filesystem with the same shas; binary extensions skipped.
4. commit.ts: `commitWritePlan(dir, plan, {identity, branch?})` — deletes, writes, appends events, `git add`/`git rm` only the plan's paths, commit with author/committer = identity and trailers; `diffFiles`, `stagedFiles`, `fileHistory`, `mergeBranch`.
5. worktree.ts: add (new branch from base) / remove / list (porcelain).
6. ledger.ts: `readLedgerUnion(dir, changeId)` over all local branches, deduped by event id; `changeIdsByRef(dir)` for validateIds.
7. attributes.ts: `installMergeUnion(dir)` idempotent.
8. Tests on a temp repo: round-trips through core (createChange → commit → readTree → derive), merge=union proof, worktrees, diff, union ledger.

## Risks
- `git cat-file --batch` output parsing must handle sizes exactly (binary-safe Buffers, not string splitting).
- Tests shell out to git; they need `user.email` set in the temp repo, never the global config.

## Proof
pnpm build, pnpm test (adapter.test.ts against real git), pnpm lint.

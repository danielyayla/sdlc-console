---
id: CHG-0018
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "With config.codeHost: github, a green per-change run pushes the task branch, opens a real pull request through the GitHub REST API, publishes an sdlc/evidence commit status, and writes pr.yaml with provider github, number, url and headSha; gate 5 merges that PR through the API (precondition = recorded headSha), refuses when the base branch is unprotected, and records mergeSha from the API; a fake GitHub API plus a bare origin repo prove both in tests; build/test/lint green"
schema: 1
---
# Plan: GitHub adapter and GitHub-mode code PR (2.1) (from spec.md n/a)

## Files that change
packages/adapters/github/package.json (new)
packages/adapters/github/tsconfig.json (new)
packages/adapters/github/tsconfig.build.json (new)
packages/adapters/github/src/index.ts (new)
packages/adapters/github/src/client.ts (new)
packages/adapters/github/src/remote.ts (new)
packages/adapters/github/src/pulls.ts (new)
packages/adapters/github/src/statuses.ts (new)
packages/adapters/github/src/codeowners.ts (new)
packages/adapters/github/src/protection.ts (new)
packages/adapters/github/src/codehost.ts (new)
packages/adapters/github/test/client.test.ts (new)
packages/adapters/github/test/codeowners.test.ts (new)
packages/adapters/github/test/codehost.test.ts (new)
packages/adapters/github/test/fake-github.ts (new)
packages/adapters/git/src/codehost.ts (new)
packages/adapters/git/src/remote.ts (new)
packages/adapters/git/src/index.ts
packages/server/src/engine/codehost.ts
packages/server/src/engine/runner.ts
packages/server/src/actions.ts
packages/server/src/serve.ts
packages/server/package.json
packages/cli/src/commands/gate.ts
packages/cli/package.json
packages/web/src/views/ChangeDetail.tsx
tsconfig.json
vitest.config.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. adapter-git: `remote.ts` (`remoteUrl`, `pushBranch`, `fetchRemote`, `mergeRemoteBranch`) and `codehost.ts` (the `CodeHost` interface, `SYSTEM_IDENTITY`, `LocalCodeHost` moved out of the server so both hosts share one contract).
2. adapter-github: `client.ts` (REST over global `fetch`, token + `GITHUB_API_URL` override, typed `GitHubError` with status and `retryable`); `remote.ts` (`parseGitHubRemote` for https/ssh origins, `credentialsFrom(env)`); `pulls.ts` (open/get/merge/requestChanges/comment with a normalised `PullRequest`); `statuses.ts` (commit status = `checks.publish` under a token); `codeowners.ts` (pure CODEOWNERS parse, last match wins); `protection.ts` (`branchProtected` via the branch resource, readable without admin).
3. adapter-github `GitHubCodeHost`: `openPr` pushes the branch, refuses when the base branch is unprotected, opens the PR, publishes `sdlc/evidence`, records `pr.yaml` (`provider: github`, number, url, headSha, `checks: [{evidence, pass}]`) with `pr.opened{number,url}` + `stage.entered{5}` on the local default branch; `merge` merges through the API with `sha` = recorded headSha, then fetches and merges `origin/<base>` into the local base branch and returns the API merge sha.
4. Server: `codeHostFor(provider, env)` in the engine; `acceptGate` and the CLI `accept` route gate 5 through the host instead of calling `mergeBranch` directly (502 with `retryable` when the API refuses).
5. Web: PR panel shows the PR link, head/merge SHA and check verdicts from `pr.yaml`.
6. Tests: fake GitHub API on `node:http` backed by a bare origin repo (merge handler performs a real git merge and pushes it), remote parsing, CODEOWNERS golden cases, protection refusal, merge precondition mismatch → 409-style error.
7. decisions.md rows; tick 2.1.

## Risks
- A personal token cannot create check runs (GitHub App only); commit statuses carry the same verdict and are readable by branch protection. Recorded as a decision; check runs return with the App in Phase 3.
- In GitHub mode the lifecycle records (`run-<n>.json`, `pr.yaml`, ledger events) still commit on the console's local default branch, which branch protection stops us from pushing. Syncing them to origin is item 2.2's ledger-sync work; until then the local clone is the console's source of truth and origin holds the code PRs and merges.
- The adapter must never merge around branch protection: it checks `protected` on the base branch and refuses otherwise, and it never uses admin bypass.

## Proof
pnpm build, pnpm test (adapter-github client/codeowners/codehost tests, server engine test unchanged for local mode), pnpm lint; manual run against danielyayla/sdlc-console is item 2.2's e2e.

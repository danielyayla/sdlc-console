---
id: CHG-0019
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "In a GitHub-mode repo with a spec drafted on sdlc/<CHG>/spec: the engine pushes the branch and opens its PR, recording pr.opened{artifact} on the branch; the snapshot shows the draft as pending-review with the PR link although main lacks it; Accept commits gate.accepted{source: pr.merge} on the branch and merges the PR through the API (stage advances, spec now on main); Send back commits gate.sent_back on the branch and posts a request-changes review; a PR merged on GitHub by a mapped tech lead is detected and recorded with that identity; local lifecycle commits reach origin through the sdlc/records PR; build/test/lint green"
schema: 1
---
# Plan: Artifact PRs as gates in GitHub mode (2.2) (from spec.md n/a)

## Files that change
packages/schemas/src/event.ts
packages/schemas/src/config.ts
packages/schemas/json/*.schema.json (generated)
packages/core/src/derive.ts
packages/core/src/transitions/artifact-pr.ts (new)
packages/core/src/transitions/index.ts
packages/core/src/config.ts
packages/adapters/git/src/tree.ts
packages/adapters/git/src/branches.ts (new)
packages/adapters/git/src/index.ts
packages/adapters/github/src/pulls.ts
packages/adapters/github/src/codehost.ts
packages/adapters/github/test/fake-github.ts
packages/server/src/store.ts
packages/server/src/actions.ts
packages/server/src/github/artifacts.ts (new)
packages/server/src/github/index.ts (new)
packages/server/src/engine/engine.ts
packages/server/src/http.ts
packages/server/src/index.ts
packages/server/test/github.test.ts
packages/adapters/git/test/adapter.test.ts
packages/cli/src/commands/gate.ts
packages/cli/src/commands/sync.ts (new)
packages/cli/src/main.ts
packages/web/src/views/ChangeDetail.tsx
docs/decisions.md
docs/build-order.md

## Order of work
1. Schemas: `pr.opened` gains optional `artifact` (index) and `branch`; identities gain optional `github` login for mapping mergers to roles. Regenerate JSON schemas.
2. adapter-git: `artifactBranches(root, base)` lists unmerged `sdlc/<CHG>/<artifact>` branches; `readTreeWithBranches(root, ref)` overlays each branch's `sdlc/changes/<CHG>/**` on the base tree with the ledger unioned, so the console sees drafts in review (both modes). Store uses it.
3. Core: `ChangeView.artifactPrs` (per artifact index: number, url, branch, headSha, merged) from `pr.opened{artifact}` events of the cycle; `recordArtifactPr` system write-plan; `identityForGitHubLogin(config, login)`.
4. adapter-github: `findOpenPull(head)`, `mergedBy` on `PullRequest`; fake API supports both (merged_by from a header the test sets).
5. Server `github/artifacts.ts`: `commitOnBranch` (existing worktree or a temporary one); `openArtifactPrs` (push, open, record on branch, push); `acceptViaPr` (commit accept plan on branch → push → API merge with sha precondition → merge origin base locally); `sendBackViaPr` (commit on branch → push → request-changes review); `detectMergedArtifactPrs` (poll, merge origin locally, record accept with the mapped merger, source pr.merge); `syncRecords` (push local base to `sdlc/records`, ensure the records PR). `acceptGate`/`sendBackGate` route to them in GitHub mode when the artifact sits on an unmerged branch. Engine ticks call `openArtifactPrs` + `syncRecords`, and polls merges at most every 30 s; `POST /api/sync` and `sdlc sync` run one pass.
6. Web: gate panel and viewer header show "in review · #n" with the PR link; tech-lead wait text links the plan PR.
7. Tests: tree overlay golden (draft visible, ledger union, no overlay for merged branches); server GitHub flow: open → pending-review → accept via PR → stage 3; send-back → review; external merge by mapped login → recorded; records PR opened and re-synced after merge.
8. decisions.md rows; tick 2.2.

## Risks
- Overlaying unmerged artifact branches changes what the console shows in local mode too (drafts become visible as pending-review before the accept merges them). That is the intended §4 behaviour and the golden tests cover it; the CLI's committed-tree reads are unchanged.
- The accept event is committed on the PR branch before the merge so the decision and the artifact land on main in one merge; the merge precondition is the branch head after that commit. A crash between push and merge leaves a PR with the decision recorded but unmerged; the next accept click merges it (idempotent by branch head).
- A merger login without a mapped identity is recorded as `<login>@users.noreply.github.com` and blocked by the gate-ownership rule until config maps it: evidence shown, no guess.
- The records PR is opened and refreshed by the system but only a human merges it; the console keeps working from its local default branch meanwhile.

## Proof
pnpm build, pnpm test (adapter overlay, github.test.ts artifact flow, existing local-mode suites unchanged), pnpm lint; then a real run against danielyayla/sdlc-console once GITHUB_TOKEN is in the serve shell.

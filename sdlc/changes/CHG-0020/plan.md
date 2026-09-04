---
id: CHG-0020
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "A change at stage 5 gets one headless review session per PR head; the session reports findings through mcp__sdlc__report_finding without touching the PR branch; on exit the system commits review.finding events, the severity tally, a findings check and the reviewed head into pr.yaml on the default branch; in GitHub mode sdlc/evidence and sdlc/evals statuses are on the PR head at open, sdlc/findings after the review, and the findings are posted verbatim as a PR review comment; the Change detail PR panel lists checks and findings; build/test/lint green"
schema: 1
---
# Plan: Review findings mirror + check runs (2.3) (from spec.md n/a)

## Files that change
packages/schemas/src/pr.ts
packages/schemas/src/event.ts
packages/schemas/json/*.schema.json (generated)
packages/core/src/repo.ts
packages/core/src/derive.ts
packages/core/src/transitions/review.ts (new)
packages/core/src/transitions/index.ts
packages/core/src/index.ts
packages/adapters/git/src/codehost.ts
packages/adapters/github/src/pulls.ts
packages/adapters/github/src/codehost.ts
packages/adapters/github/src/index.ts
packages/mcp/src/sessions.ts
packages/mcp/src/tools.ts
packages/mcp/src/context-bundle.ts
packages/mcp/src/index.ts
packages/mcp/test/tools.test.ts
packages/server/src/sessions/registry.ts
packages/server/src/sessions/launcher.ts
packages/server/src/sessions/prompts.ts
packages/server/src/engine/runner.ts
packages/server/src/engine/review.ts (new)
packages/server/src/engine/engine.ts
packages/server/src/engine/jobs.ts
packages/server/src/engine/index.ts
packages/server/src/index.ts
packages/server/test/review.test.ts (new)
packages/server/test/github.test.ts
packages/cli/src/commands/session.ts
packages/web/src/views/ChangeDetail.tsx
docs/decisions.md
docs/build-order.md

## Order of work
1. Schemas: `pr.yaml` gains optional `review {session, headSha, at}`; `review.finding` data gains optional `detail`. Regenerate JSON schemas.
2. Core: `Repo.reviewPolicy` (REVIEW.md sha + text, parsed never edited); `ChangeView.findings` from the cycle's `review.finding` events after the code PR opened; `recordReview` write-plan (events with the agent actor, `pr.yaml` tally + `findings` check + `review` block) — pure.
3. adapter-git: `OpenPrInput.checks[]` (name, verdict, summary) replaces the single evidence field; `CodeHost.reportReview(root, pr, report)`; `LocalCodeHost` records nothing beyond the write-plan.
4. adapter-github: one commit status per check at open (`sdlc/evidence`, `sdlc/evals`); `reportReview` publishes `sdlc/findings` (failure when a high finding exists) on the PR head and posts the findings verbatim as a `COMMENT` review; `reviewPull` generalises `requestChanges`.
5. MCP: `report_finding {changeId, severity, title, path?, detail?}` appends to the session's `findings.jsonl` (like rounds) and refuses when the change has no PR; stage-5 bundle allows `Read, Grep, Glob, report_finding, log_note`.
6. Server: session kind `review` — runs read-only in the PR branch worktree, its `session.*` events commit on the default branch so the PR head stays the tested head; prompt is REVIEW.md verbatim plus the reporting contract. Engine launches one review per (change, cycle, PR head) when `pr.review.headSha` differs from `pr.headSha`; on exit `mirrorReview` commits the write-plan as sdlc-bot and calls `reportReview` in GitHub mode. Runner passes `checks` from the run (verification commands, intersecting eval cases).
7. Web: PR panel lists checks by name, the reviewed head, and each finding with a severity chip and path.
8. Tests: MCP tool refusal/append; server local-mode review (events, tally, check, review block; no code host calls); GitHub-mode review (statuses at open, findings status + review comment, engine launches once per head, replay is a no-op).
9. decisions.md rows; tick 2.3.

## Risks
- A review that commits on the PR branch would move the head past the tested run and break the merge precondition; the review session therefore writes nothing to git — its events land on the default branch with the other lifecycle records.
- Statuses are published for the PR head only; a head that moves after review (fix pushed) shows a stale review until 2.4's synchronize webhook re-runs it. Until then `pr.review.headSha ≠ pr.headSha` is visible in the panel.
- The review harness is Claude Code with read-only tools; no findings is a valid outcome and still records the reviewed head so the review is not relaunched.

## Proof
pnpm build, pnpm test (mcp report_finding, server review.test.ts, github.test.ts statuses), pnpm lint.

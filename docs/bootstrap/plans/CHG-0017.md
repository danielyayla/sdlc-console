---
id: CHG-0017
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Rendering the seed snapshot's Config view shows the CLAUDE.md card (version, word count vs one page, working rule, verification rows), subagents, the skills table with backed-by/must-hold, the hooks table with scope and warnings, the records mapping, the open proposal, and the evals section (suite size amber under 20, pass % vs threshold, run strip, case table with status filter, drafts marked 'checks missing'); proposal dismiss needs a reason; build/test/lint green"
schema: 1
---
# Plan: Config view read-only + eval case table (1.8) (from spec.md n/a)

## Files that change
packages/core/src/transitions/proposal.ts (new)
packages/core/src/transitions/index.ts
packages/core/test/transitions.test.ts
packages/server/src/actions.ts
packages/server/src/http.ts
packages/web/src/views/Config.tsx (new)
packages/web/src/app.tsx
packages/web/src/tokens.css
packages/web/test/render.test.tsx
docs/decisions.md
docs/build-order.md

## Order of work
1. core: `dismissProposal(repo, id, reason, ctx)` write-plan (reason required; owner per config: platform or eng); accept stays Phase 2 (opens a PR on the code host).
2. server: `POST /api/proposals/:id/dismiss`; `/accept` answers 409 with the Phase 2 reason.
3. web Config: eval-gate banner (suite size, pass %, threshold, mode, "Run suite" disabled: needs CI adapter), CLAUDE.md card (version, "under one page" / amber over, freshness = last run's config sha match, working rule, verification command rows with single-target warnings), subagents list, skills table (name · trigger · owner · backed by · must hold), hooks table (name · action chip · description · phase · scope · warnings) with the managed footer, records mapping row, proposals (text, citations, Dismiss with reason, Accept disabled), evals case table (id · prompt · source chip · owner · status · pass history sparkline from runs) with status filter and draft "checks missing"; parse warnings per card from validation diagnostics.
4. Render test; decisions; tick 1.8.

## Risks
- The view is read-only by design; the only mutation is a proposal dismissal, which is a logged, reasoned decision (FR-22).

## Proof
pnpm build, pnpm test (render.test.tsx Config cases, transitions proposal test, server route), pnpm lint.

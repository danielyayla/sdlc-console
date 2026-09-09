---
id: CHG-0012
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Over the seed: Loop renders the bands table and both triage cards and accepting TRI-0042 through the server creates CHG-0024 and decrements the badge (acceptance c); Security renders three findings and escalating SEC-0118 creates a change and marks it escalated (acceptance d); Metrics shows six stage cards from git + ledger with 'n/a · needs <source>' where a source is missing; findings import from CSV/MD allocates SEC ids; build/test/lint green"
schema: 1
---
# Plan: Web — Loop, Security, Metrics from git + ledger (1.3) (from spec.md n/a)

## Files that change
packages/schemas/src/parse/findings-import.ts (new)
packages/schemas/src/parse/index.ts
packages/schemas/test/findings-import.test.ts (new)
packages/core/src/metrics.ts (new)
packages/core/src/transitions/finding.ts
packages/core/src/index.ts
packages/core/test/metrics.test.ts (new)
packages/core/test/transitions.test.ts
packages/server/src/snapshot.ts
packages/server/src/actions.ts
packages/server/src/http.ts
packages/server/test/serve.test.ts
packages/cli/src/commands/triage.ts (new)
packages/cli/src/commands/security.ts (new)
packages/cli/src/main.ts
packages/cli/test/cli.test.ts
packages/web/src/views/Loop.tsx (new)
packages/web/src/views/Security.tsx (new)
packages/web/src/views/Metrics.tsx (new)
packages/web/src/app.tsx
packages/web/src/tokens.css
packages/web/test/render.test.tsx
docs/decisions.md
docs/build-order.md

## Order of work
1. schemas: `parseFindingsImport(text)` for CSV (header row) and Markdown tables → rows {scannerId, sev, conf, repo, title, desc}.
2. core: `importFindings(repo, rows, ctx)` allocating SEC-NNNN ids, matching existing scanner ids (dismissed stays dismissed); `computeMetrics(repo, views, {now, windowDays})` — per-stage leading/lagging values from git + ledger with trend vs the previous window and `n/a · needs <source>` notes.
3. server: snapshot gains `metrics`; `POST /api/findings/import` {text}.
4. cli: `triage accept|dismiss`, `security patch|escalate|dismiss|import`.
5. web: Loop (bands table with tier footer, triage cards with Accept → Plan / Dismiss · tune band), Security (subhead, severity chips, Patch → PR gate / Wider than one patch → intent.md / Dismiss with reason, dismissed at 50%), Metrics (six cards, LEADING/LAGGING halves, trend chips); wired into the view enum.
6. Tests at every layer; decisions; tick 1.3.

## Risks
- Metrics from a 30-day window over seed data are sparse; trends fall back to "—" rather than inventing direction.
- Dismiss needs a reason: the UI uses a text prompt; empty input cancels.

## Proof
pnpm build, pnpm test (metrics, findings-import, render, server, cli), pnpm lint.

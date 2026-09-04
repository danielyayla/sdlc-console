---
id: CHG-0027
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Metrics declare their sources (git, ledger, PR metadata, CI, incident records, evals) and read PR/CI/incident facts from a rebuildable cache the server fills from the git mirror and, in GitHub mode, from the PR reviews and commit statuses API; review time per PR, first-pass CI for agent PRs, incident → active eval, regressions caught in CI vs prod, incident → fix merged and deploy failures show values on the seed; a metric whose source has no facts and no adapter says 'n/a · needs <source>'; every trend chip shows direction and % change against the previous window; sdlc metrics [--stage] [--window] [--json] and GET /api/metrics?window= exist; pnpm build/test/lint green"
schema: 1
---
# Plan: Metrics from PR/CI/incident sources; trend chips — build-order 2.10 (FR-70, spec §4.8, 5B.6, blueprint 7.11)

## Files that change
packages/core/src/metrics.ts                       (catalogue with keys, sources per metric, previous/delta on trend; source-fed metrics)
packages/core/src/metricSources.ts (new)           (PrFact/CiFact/IncidentFact; pure factsFromRepo(repo) over pr.yaml, runs, suite runs, incident.md, triage)
packages/core/src/index.ts
packages/adapters/github/src/pulls.ts              (listReviews)
packages/adapters/github/src/statuses.ts           (combinedStatus)
packages/adapters/github/test/fake-github.ts       (GET /pulls/:n/reviews, GET /commits/:sha/status)
packages/adapters/github/test/client.test.ts       (the two reads)
packages/server/src/metrics/cache.ts (new)         (FactsCache: SQLite table metric_facts in the shared disposable db)
packages/server/src/metrics/index.ts (new)         (collectSources: mirror + cached GitHub facts; refreshFacts: fetch reviews/statuses for recorded PRs)
packages/server/src/snapshot.ts                    (metrics computed with sources; Snapshot.metricSources freshness)
packages/server/src/store.ts                       (StoreOptions.facts provider)
packages/server/src/serve.ts                       (wire cache + provider)
packages/server/src/engine/engine.ts               (refreshFacts on each GitHub sync pass; public refreshMetricFacts)
packages/server/src/http.ts                        (GET /api/metrics?window=7d|30d|90d)
packages/server/src/index.ts
packages/cli/src/commands/metrics.ts (new)         (sdlc metrics [--stage n] [--window 30d] [--refresh] [--json])
packages/cli/src/main.ts
packages/web/src/views/Metrics.tsx                 (trend chip with %; source chips; sources/freshness header)
packages/web/src/tokens.css
fixtures/src/seed.ts                               (CHG-0012 pr.yaml carries the review job's `review`; CHG-0017 review too)
fixtures/seed/**                                   (regenerated)
packages/core/test/metrics.test.ts
packages/server/test/metrics.test.ts (new)
packages/server/test/serve.test.ts
packages/cli/test/cli.test.ts
packages/web/test/render.test.tsx
docs/decisions.md, docs/build-order.md

## Order of work
1. Core facts: `factsFromRepo(repo)` → `{pr, ci, incidents}`; each list is null when the repo holds nothing for it (no pr.yaml / no runs, checks or suite runs / no incident.md or incident triage) so a metric can say what it needs. PR facts from `pr.yaml` (openedAt, mergedAt, first review = `review.at` of the review job, agent-authored from the ledger's `pr.opened` actor); CI facts from per-change runs (origin `run`), `pr.yaml.checks` (origin `status`) and `config-pr` suite runs (origin `suite`); incident facts from `incident.md` front-matter and open/accepted `incident`-tier triage items.
2. Core catalogue: every metric gets a `key`, `sources[]`, and the trend carries `previous` and `delta` (% vs previous window, rounded). New/changed metrics: stage 4 leading `first-pass CI (agent PRs)`, `incident → active eval`; lagging `review time per PR`, `change failure rate` (incidents attributed to merged changes), `regressions caught in CI vs prod`; stage 5 lagging `deploy failures`; stage 6 lagging `incidents recorded` (by origin), `incident → fix merged`. `breached bands` stays n/a (detection snapshots have no home yet).
3. GitHub adapter: `listReviews(number)` → `{submittedAt, state, login}`; `combinedStatus(sha)` → `{state, statuses[{context, state, createdAt, updatedAt}]}`; fake GitHub serves both from its recorded state.
4. Server: `FactsCache` (rows keyed `pr:<number>:<head>` / `ci:<head>`, json + fetchedAt); `refreshFacts(host, repo, cache, now)` fetches for every GitHub `pr.yaml` (merged heads once, open heads on every pass); `collectSources(repo, cache)` overlays cached GitHub facts on the mirror (first human review wins over the review job; statuses add timing) and reports `via`/`fetchedAt` per source. Engine calls refresh inside the GitHub sync pass. Snapshot gains `metricSources`.
5. HTTP `GET /api/metrics?window=`; CLI `sdlc metrics`; web chips + header.
6. Seed: CHG-0012 `pr.yaml.review` at the review.finding time (08-22 16:00) and CHG-0017's at 09-01 16:30. Regenerate; fix goldens.
7. Tests, gates, decisions rows, tick.

## Risks
- Trend deltas on tiny counts swing wildly; the chip shows the % but the note keeps the sample size, and ±5% stays flat.
- GitHub facts are a cache: a stale cache after a restart is shown as such (`fetched <ts>`), never silently treated as current; deleting `.sdlc-state` loses nothing lifecycle-related.
- The seed gains `review` on two PRs: any golden asserting the exact pr.yaml text must be regenerated, not edited by hand.

## Proof
- packages/core/test/metrics.test.ts: seed values for the six new metrics; empty repo says `n/a · needs PR metadata|CI|incident records`; delta/previous on trends.
- packages/server/test/metrics.test.ts: fake GitHub with a human review and a commit status → cache rows, `via: github`, review time from the human review, CI timing from the status; second pass hits the cache for merged heads.
- packages/server/test/serve.test.ts: `GET /api/metrics?window=7d` returns the window and sources.
- packages/cli/test/cli.test.ts: `sdlc metrics --json` and the table.
- packages/web/test/render.test.tsx: chips carry the % and the sources header renders.

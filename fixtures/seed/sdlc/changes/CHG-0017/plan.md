---
id: CHG-0017
artifact: plan
cycle: 1
spec_sha: cbd36d92629e8bc810c85038ac8d22dc721c00bc
rev: 1
accepted_by: eng@veri.example
accepted_at: 2026-08-27T10:00:00Z
acceptance_line: GET /export?month=2026-08 returns 3 fixture invoices as CSV; tests pass
context_manifest: sha256:seed-plan-session
schema: 1
---
# Plan: Invoice CSV export (from spec.md cbd36d92629e)

## Files that change
src/export/csv.ts (new)
src/export/route.ts (new)
test/export/csv.test.ts (new)

## Order of work
1. csv writer
2. route
3. tests

## Risks
Large months stream slowly.

## Proof
test/export/csv.test.ts

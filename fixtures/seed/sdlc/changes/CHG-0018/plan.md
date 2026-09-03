---
id: CHG-0018
artifact: plan
cycle: 1
spec_sha: 3b1cacc318e8f41d08db03c4c206dd6cfdec474e
rev: 1
accepted_by: eng@veri.example
accepted_at: 2026-08-29T11:00:00Z
acceptance_line: test/export/zero-total.test.ts passes; no other test changes
context_manifest: sha256:seed-plan-session
schema: 1
---
# Plan: Export drops invoices with zero total (from spec.md 3b1cacc318e8)

## Files that change
src/export/csv.ts
test/export/zero-total.test.ts (new)

## Order of work
1. repro test
2. fix filter

## Risks
None.

## Proof
repro test green, unchanged in diff

---
id: CHG-0020
artifact: plan
cycle: 1
spec_sha: cccfa405097e256bb5f8abeec4df07ecd3414bd5
rev: 2
accepted_by: null
accepted_at: null
acceptance_line: test/export/csv.test.ts asserts the 5-column order and passes
context_manifest: sha256:seed-plan-session
schema: 1
---
# Plan: Export column order matches the finance template (from spec.md cccfa405097e)

## Files that change
src/export/csv.ts
test/export/csv.test.ts

## Order of work
1. header constant
2. test

## Risks
None.

## Proof
test/export/csv.test.ts

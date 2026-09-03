---
id: CHG-0018
artifact: intent
cycle: 1
author: po@veri.example
created: 2026-08-29T09:00:00Z
status: final
context_manifest: sha256:seed-intent-session
schema: 1
---
# Intent: Export drops invoices with zero total

## Problem
Invoices with a zero total are missing from the CSV export.

## Proposed outcome
Every invoice of the month appears, zero totals included.

## Affected users and systems
Finance; export API.

## Constraints
Failing test first; no other test changes.

## Open questions
None.

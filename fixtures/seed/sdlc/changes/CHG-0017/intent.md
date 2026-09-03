---
id: CHG-0017
artifact: intent
cycle: 1
author: po@veri.example
created: 2026-08-26T09:00:00Z
status: final
context_manifest: sha256:seed-intent-session
schema: 1
---
# Intent: Invoice CSV export

## Problem
Finance re-keys invoices into spreadsheets every month.

## Proposed outcome
One CSV per month with all invoice lines.

## Affected users and systems
Finance team; invoicing API.

## Constraints
No PII beyond invoice ids and totals.

## Open questions
None.

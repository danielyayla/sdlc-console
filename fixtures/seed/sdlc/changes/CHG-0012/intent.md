---
id: CHG-0012
artifact: intent
cycle: 1
author: po@veri.example
created: 2026-08-20T09:00:00Z
status: final
context_manifest: sha256:seed-intent-session
schema: 1
---
# Intent: Invoice PDF rendering

## Problem
Invoices render as HTML only; customers ask for PDF.

## Proposed outcome
A PDF download per invoice, identical to the HTML layout.

## Affected users and systems
Customers; invoicing web; storage.

## Constraints
No third-party rendering service; PDFs under 1 MB.

## Open questions
None.

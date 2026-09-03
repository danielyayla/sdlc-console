---
id: CHG-0012
artifact: plan
cycle: 1
spec_sha: 84d62dc83e65704bec36d7387cd70e33ff518651
rev: 2
accepted_by: eng@veri.example
accepted_at: 2026-08-21T10:00:00Z
acceptance_line: GET /invoices/:id.pdf returns a PDF under 1 MB for the 3 fixture invoices
context_manifest: sha256:seed-plan-session
schema: 1
---
# Plan: Invoice PDF rendering (from spec.md 84d62dc83e65)

## Files that change
src/invoice/pdf.ts (new)
src/invoice/route.ts
test/invoice/pdf.test.ts (new)

## Order of work
1. render pipeline
2. route
3. tests

## Risks
Print CSS drift.

## Proof
test/invoice/pdf.test.ts + screenshot diff

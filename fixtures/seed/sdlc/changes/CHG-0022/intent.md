---
id: CHG-0022
artifact: intent
cycle: 1
author: po@veri.example
created: 2026-09-02T09:00:00Z
status: final
context_manifest: sha256:seed-intent-session
schema: 1
---
# Intent: Multi-currency invoice totals

## Problem
Invoices in EUR and GBP show totals without a currency, so finance mis-books them.

## Proposed outcome
Every total carries its ISO currency code and a converted base-currency figure.

## Affected users and systems
Finance; customers outside the US; invoicing API and PDF.

## Constraints
Rates from the existing FX feed only.

## Open questions
Round at line or at total?

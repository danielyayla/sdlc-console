---
id: CHG-0019
artifact: intent
cycle: 1
author: po@veri.example
created: 2026-08-30T09:00:00Z
status: final
context_manifest: sha256:seed-intent-session
schema: 1
---
# Intent: Payment provider migration

## Problem
The current payment provider is sunsetting its API in Q4.

## Proposed outcome
Payments run on the new provider with no customer-visible change.

## Affected users and systems
Checkout; billing; every paying customer.

## Constraints
Dual-run for two weeks; PCI scope unchanged.

## Open questions
Refund history migration?

---
id: CHG-0019
artifact: plan
cycle: 1
spec_sha: f8ce0ff7501d572d7e8e75550b1c0e9d20100c0b
rev: 3
accepted_by: null
accepted_at: null
acceptance_line: dual-run reconciliation shows 0 mismatches over the fixture ledger; all tests pass
context_manifest: sha256:seed-plan-session
schema: 1
---
# Plan: Payment provider migration (from spec.md f8ce0ff7501d)

## Files that change
src/payments/gateway.ts
src/payments/providers/newco.ts (new)
src/payments/flags.ts (new)
src/checkout/pay.ts
test/payments/newco.test.ts (new)
test/payments/reconcile.test.ts (new)

## Order of work
1. adapter
2. flag
3. checkout wiring
4. reconciliation tests

## Risks
Webhook signature differences; refund mapping.

## Proof
test/payments/*; reconciliation report

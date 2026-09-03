---
id: CHG-0019
artifact: spec
cycle: 1
intent_sha: 45767b12f07c75cc7f5ab78a7648f19150e7faa2
prompt_ref: prompts/design-pass@1
skills:
  - name: brand
    version: 1.2.0
concerns:
  - id: C1
    policy: compliance
    owner: security@veri.example
    resolved: true
created: 2026-08-30T13:00:00Z
context_manifest: sha256:seed-design-pass
schema: 1
---
# Spec: Payment provider migration

## Requirements
Provider adapter interface; feature flag; dual-run reconciliation.

## Design
Adapter behind PaymentGateway; flag per tenant.

## Areas of concern
C1 compliance (PCI) — resolved with security lead; C2 tech lead consulted.

## Open questions carried forward
Refund history migration.

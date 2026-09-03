---
id: CHG-0018
artifact: spec
cycle: 1
intent_sha: 96181610bd46ddae350c3ecc77dbd4d2739040fd
prompt_ref: prompts/design-pass@1
skills:
  - name: brand
    version: 1.2.0
concerns: []
created: 2026-08-29T10:00:00Z
context_manifest: sha256:seed-design-pass
schema: 1
---
# Spec: Export drops invoices with zero total

## Requirements
Rows with total 0 are exported.

## Design
Remove the truthiness filter in the row mapper.

## Areas of concern
None flagged.

## Open questions carried forward
None.

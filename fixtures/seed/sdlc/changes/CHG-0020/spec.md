---
id: CHG-0020
artifact: spec
cycle: 1
intent_sha: 517ec8676ee5308ad01c681398bc7ce120bd931c
prompt_ref: prompts/design-pass@1
skills:
  - name: brand
    version: 1.2.0
concerns: []
created: 2026-08-31T10:00:00Z
context_manifest: sha256:seed-design-pass
schema: 1
---
# Spec: Export column order matches the finance template

## Requirements
Column order: id, date, customer, total, currency.

## Design
Ordered header constant in the CSV writer.

## Areas of concern
None flagged.

## Open questions carried forward
None.

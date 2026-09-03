---
id: CHG-0021
artifact: spec
cycle: 1
intent_sha: a1c8e67b55958c067a7485f398629d28537680c8
prompt_ref: prompts/design-pass@1
skills:
  - name: brand
    version: 1.2.0
concerns:
  - id: C1
    policy: brand
    owner: marketing@veri.example
    resolved: false
created: 2026-09-01T11:00:00Z
context_manifest: sha256:seed-design-pass
schema: 1
---
# Spec: Customer portal invoice search

## Requirements
Search box with number/date/amount filters; results under 300 ms.

## Design
Indexed query on the invoice read model; debounced client.

## Areas of concern
C1 brand: copy reviewed by marketing (open).

## Open questions carried forward
Fuzzy matching on customer names.

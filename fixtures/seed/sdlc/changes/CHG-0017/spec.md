---
id: CHG-0017
artifact: spec
cycle: 1
intent_sha: 0d0bae7a016ef0f83aac65fdbe34d071032381d7
prompt_ref: prompts/design-pass@1
skills:
  - name: brand
    version: 1.2.0
concerns: []
created: 2026-08-26T11:00:00Z
context_manifest: sha256:seed-design-pass
schema: 1
---
# Spec: Invoice CSV export

## Requirements
GET /export?month=YYYY-MM returns CSV.

## Design
Streaming CSV from the invoice repository.

## Areas of concern
None flagged.

## Open questions carried forward
None.

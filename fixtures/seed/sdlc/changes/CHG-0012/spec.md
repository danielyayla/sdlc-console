---
id: CHG-0012
artifact: spec
cycle: 1
intent_sha: 5ed41f66b6a5a8d0934cc0c375645e00b196ad35
prompt_ref: prompts/design-pass@1
skills:
  - name: brand
    version: 1.2.0
concerns:
  - id: C1
    policy: privacy
    owner: legal@veri.example
    resolved: true
    note: expiring links
created: 2026-08-20T11:00:00Z
context_manifest: sha256:seed-design-pass
schema: 1
---
# Spec: Invoice PDF rendering

## Requirements
Render invoice to PDF server-side; link on invoice page.

## Design
Headless browser print pipeline behind a queue.

## Areas of concern
C1 privacy: PDFs contain addresses — resolved with expiring links.

## Open questions carried forward
None.

---
id: CHG-0012
artifact: incident
cycle: 1
src: metric:error_rate
tier: incident
created: 2026-09-02T07:30:00Z
context_manifest: sha256:seed-diagnose
schema: 1
---
# Incident: PDF rendering timeouts after deploy

## Anomaly and evidence
error_rate_pct 3.1% vs baseline 0.4% (3σ) since 2026-09-02 06:40; 212 PDF requests timed out at 30 s.

## Proposed outcome
PDF rendering under 5 s p95 with no timeouts.

## Affected systems
invoicing web; pdf queue; customers downloading invoices.

## Open questions
Is the queue starved by the nightly export?

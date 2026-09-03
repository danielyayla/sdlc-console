---
id: CHG-0002
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "pnpm build/test/lint green; validate() accepts every fixture sample and rejects an agent-authored gate.accepted; json/*.schema.json in sync with generated output"
schema: 1
---
# Plan: Schemas, build-order item 0.2 (from spec.md n/a)

## Files that change
packages/schemas/package.json
packages/schemas/src/index.ts
packages/schemas/src/common.ts (new)
packages/schemas/src/change.ts (new)
packages/schemas/src/event.ts (new)
packages/schemas/src/config.ts (new)
packages/schemas/src/tasks.ts (new)
packages/schemas/src/evals.ts (new)
packages/schemas/src/pr.ts (new)
packages/schemas/src/deploy.ts (new)
packages/schemas/src/triage.ts (new)
packages/schemas/src/finding.ts (new)
packages/schemas/src/proposal.ts (new)
packages/schemas/src/frontmatter.ts (new)
packages/schemas/src/registry.ts (new)
packages/schemas/src/validate.ts (new)
packages/schemas/scripts/generate.mjs (new)
packages/schemas/json/*.schema.json (new, generated)
packages/schemas/test/index.test.ts
packages/schemas/test/samples.ts (new)
packages/schemas/test/validate.test.ts (new)
packages/schemas/test/json-sync.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. Add deps zod, ajv, ajv-formats to @sdlc/schemas.
2. common.ts: ids, sha, timestamp, enums, actor union (agent actor requires session).
3. Entity schemas as z.strictObject: change.yaml, log.jsonl event union (gate.accepted restricted to human actor, stage.entered to system), config.yaml (+ CONFIG_DEFAULTS), tasks.yaml, eval case/run, per-change run, round, repro proof, pr.yaml, deploy.yaml, triage, finding, proposal, front-matter intent/spec/plan/incident.
4. registry.ts: name → zod schema; jsonSchemas generated with z.toJSONSchema; event union post-processed to oneOf + discriminator.
5. validate.ts: Ajv 2020 + formats compiles every JSON schema once; validate(name, value, filePath?) → {ok, value} | {ok:false, diagnostics[]} with Diagnostic {path, pointer, severity, message, rule}.
6. generate.mjs writes json/<name>.schema.json from dist; json-sync test proves committed files equal generated.
7. Tests: valid sample per entity passes; targeted invalid samples fail with the right pointer; agent-authored gate.accepted rejected; all schemas compile under Ajv strict.
8. Record decisions in docs/decisions.md "Decisions made during build"; tick 0.2.

## Risks
- Ajv strict mode may reject zod-emitted keywords; fix by post-processing the generated schema, not by loosening Ajv globally.
- Two representations (zod, JSON) — the json-sync test is what keeps them aligned.

## Proof
pnpm build, pnpm test (schemas tests listed above), pnpm lint; `git diff --exit-code packages/schemas/json` after regenerating.

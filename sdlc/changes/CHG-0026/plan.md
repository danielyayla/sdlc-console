---
id: CHG-0026
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "records.<artifact> = external|linked drives write-backs through the MCP connector named in .mcp.json: accept in external mode stays accepted and queues a retryable write-back job (ok/failed on the ledger, amber 'write-back failed · retry' with a working retry from console and CLI); linked mode refuses accept until change.yaml has the record and the artifact's commit sha has been written back; the viewer header says authoritative vs copy of <record> · synced <ts>; pnpm build/test/lint green"
schema: 1
---
# Plan: Records mode (`external`/`linked`) with MCP write-back and retry — build-order 2.9 (FR-16, spec 5A.6)

## Files that change
packages/schemas/src/event.ts                      (record.writeback.ok/failed carry artifact, kind, sha, url; new record.linked)
packages/schemas/src/config.ts                     (records.connector documented as the .mcp.json server name)
packages/schemas/json/*.json                       (regenerated)
packages/core/src/records.ts (new)                 (pure: required/pending write-backs, sync state per artifact, link block)
packages/core/src/derive.ts                        (DocView.record: mode, chip, syncedAt, writeback; ChangeView.recordBlock)
packages/core/src/transitions/accept.ts            (linked: refuse until the artifact sha was written back)
packages/core/src/transitions/record.ts (new)      (linkRecord — human; recordWriteback — system outcome event)
packages/core/src/transitions/index.ts
packages/core/src/validate/rules.ts                (warning records.connector-missing)
packages/core/src/activity.ts                      (record.linked line)
packages/core/src/index.ts
packages/server/package.json                       (@modelcontextprotocol/sdk client)
packages/server/src/records/connector.ts (new)     (.mcp.json → stdio MCP client; record_get, record_write_back)
packages/server/src/records/index.ts (new)
packages/server/src/records.ts (new)               (linkRecordAction, retryWritebackAction, runWriteback)
packages/server/src/engine/jobs.ts                 (kind record-writeback)
packages/server/src/engine/engine.ts               (forWritebacks on tick: pending → job with in-job retries; failed → periodic auto-retry)
packages/server/src/http.ts                        (POST /api/changes/:id/records/link, /records/retry)
packages/server/src/index.ts
packages/cli/src/commands/record.ts (new)          (sdlc record link|retry|status)
packages/cli/src/main.ts
packages/web/src/lib/format.ts                     (viewer header: authoritative · linked X / copy of X · synced ts)
packages/web/src/views/ChangeDetail.tsx            (record chip with link, write-back status + retry, linked block message, link form)
packages/web/src/views/Config.tsx                  (records row shows the connector)
packages/web/src/app.tsx
fixtures/src/seed.ts                               (records.incident external + connector; CHG-0012 servicenow record + writeback.ok; CHG-0017 jira record; .mcp.json)
fixtures/seed/**                                   (regenerated)
packages/server/test/fixtures/fake-connector.mjs (new)
packages/core/test/records.test.ts (new)
packages/server/test/records.test.ts (new)
packages/cli/test/cli.test.ts
packages/web/test/render.test.tsx
docs/decisions.md, docs/build-order.md

## Order of work
1. Schemas: extend the two write-back events (optional `artifact`, `kind: committed|accepted`, `sha`, `url`) and add `record.linked{system,id,url?}` (human). Build, regenerate JSON.
2. Core `records.ts`: `requiredWritebacks(repo, files)` — for every artifact whose mode is `external` or `linked`, one entry per `gate.accepted` (kind accepted, sha = artifactSha) and, in linked mode, per `artifact.committed` (kind committed); state from the matching ok/failed events (by artifact, kind, sha). `pendingWritebacks(repo)` across changes; `recordSync(files, index)` → syncedAt; `linkBlock(view)` text for a linked artifact at an open gate. DocView gains `record {mode, chip, url, syncedAt, writeback}`; ChangeView gains `recordBlock`.
3. Transitions: `linkRecord` (writes change.yaml.record, event record.linked, refuses when a record is already set — records are linked once, or when the change has no artifact outside repo mode); `recordWriteback` (system event ok/failed, refuses a duplicate ok). Accept: linked mode also needs a `record.writeback.ok{artifact, committed, sha = doc.sha}`.
4. Server connector: parse `.mcp.json` (`mcpServers.<records.connector>`: command, args, env, cwd) and call the connector over stdio with the SDK client, one process per call; tools `record_get` and `record_write_back`; a tool error or transport failure is a `ConnectorError` (retryable). `runWriteback` = up to 3 attempts with backoff, then commits the outcome event by sdlc-bot on the default branch.
5. Engine: `forWritebacks` on every tick — pending → job `writeback:<CHG>:<idx>:<kind>:<sha7>`; failed jobs re-run silently after `writebackRetryMs` (a later success records ok; the ledger keeps the first failure). Retry action runs at once and answers 200 or 502 retryable.
6. HTTP + CLI + web.
7. Seed: `records.incident: external`, `connector: records`, `.mcp.json` with `sdlc` and `records` entries; CHG-0012 gets the ServiceNow record and a `record.writeback.ok` for its incident commit; CHG-0017 gets its Jira record. Regenerate; fix goldens.
8. Tests, then gates, decisions rows, tick.

## Risks
- The engine now spawns the connector on ticks whenever something is pending: the seed must have nothing pending (it has none) and tests that turn `autoLaunch` on must not accidentally reach a real connector — the seed's connector command is a placeholder that only tests with pending write-backs replace with the fake.
- Linked mode changes accept semantics for existing tests that set `records.intent: linked` — they expect `gate.linked.record-missing`, which stays the first refusal.
- A dead connector must not block anything but a linked accept: external accept stays accepted; jobs are cache state.

## Proof
packages/core/test/records.test.ts (required/pending write-backs, sync state, accept refusals in linked mode, linkRecord, recordWriteback), packages/server/test/records.test.ts (fake MCP connector: engine writes back after an external accept, retry after failure through the action, linked accept blocked until the committed write-back lands), CLI and web render tests; `pnpm build`, `pnpm test`, `pnpm lint`.

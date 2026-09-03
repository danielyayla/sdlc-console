---
id: CHG-0014
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "An MCP client over an in-memory transport against a seeded repo lists exactly the nine agent tools (no accept/merge/approve), propose_artifact validates and commits an intent on a change branch with the manifest hash and chaining shas filled in, submit_plan_revision opens gate 3 when final, report_round/report_done enforce green-before-done, and accept on main merges the artifact branch first; build/test/lint green"
schema: 1
---
# Plan: MCP server for agents (1.5) (from spec.md n/a)

## Files that change
pnpm-workspace.yaml
tsconfig.json
vitest.config.ts
packages/mcp/package.json (new)
packages/mcp/tsconfig.json (new)
packages/mcp/tsconfig.build.json (new)
packages/mcp/src/index.ts (new)
packages/mcp/src/identity.ts (new)
packages/mcp/src/context-bundle.ts (new)
packages/mcp/src/sessions.ts (new)
packages/mcp/src/tools.ts (new)
packages/mcp/src/server.ts (new)
packages/mcp/test/index.test.ts (new)
packages/mcp/test/tools.test.ts (new)
packages/adapters/git/src/git.ts
packages/server/src/actions.ts
packages/cli/package.json
packages/cli/tsconfig.build.json
packages/cli/src/commands/gate.ts
packages/cli/src/commands/mcp.ts (new)
packages/cli/src/commands/init.ts
packages/cli/src/main.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Scaffold `@sdlc/mcp` with `@modelcontextprotocol/sdk`; CLI `sdlc mcp` runs it over stdio; `sdlc init` writes `.mcp.json` (create-only).
2. identity.ts: agent identity for commits (`claude-code <claude-code@sdlc.local>`, `SDLC_AGENT_ID` override) and the session id (`SDLC_SESSION` default).
3. context-bundle.ts: per-stage bundle listing (§8.3) with shas, prompt template ref, allowed tools, and the manifest hash written into `context_manifest`.
4. sessions.ts: rounds under `.sdlc-state/sessions/<id>/rounds.jsonl`, waiting-on-you marker, loop state (iterating/green/stalled/flaky) from maxLoopRounds and repeated failures.
5. tools.ts: list_work, get_change, get_context, propose_artifact (front-matter completed and chained, validated by parseArtifact, committed on the current branch — refused on the default branch), submit_plan_revision (rev+1, plan.drafted/plan.final), report_round, report_done (verify-before-done; final-round.json + session.stopped committed), request_input, log_note. Every write commits with the agent identity; no accept/merge/approve tool.
6. adapter: `branchExists`, `isAncestor`; server + CLI accept merge `sdlc/<CHG>/<artifact>` into the default branch before accepting gates 1/2/3/6 (local mode).
7. Tests with the SDK client over `InMemoryTransport`; decisions; tick 1.5.

## Risks
- The SDK's tool input schemas are zod v4 shapes; keep them composed from `@sdlc/schemas` so the JSON schema stays the schema layer's.
- Branch switching is never done by the MCP server; the launcher (1.6) prepares worktrees.

## Proof
pnpm build, pnpm test (packages/mcp/test/tools.test.ts), pnpm lint; `sdlc mcp` starts and answers `tools/list` over stdio.

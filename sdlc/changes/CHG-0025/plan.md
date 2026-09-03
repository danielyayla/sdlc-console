---
id: CHG-0025
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Two hook blocks or send-backs across sessions citing the same normalised reason derive a repeat signal (pure); with the engine on, one keyed claude-md-proposal job launches a headless propose session that reads the cluster, CLAUDE.md and the word budget and files sdlc/proposals/PRP-NNNN.yaml (reason, citations) through mcp__sdlc__propose_claude_md_line + a system mirror; a third occurrence increments the count and files no second proposal; Accept (eng or platform) commits the line on branch sdlc/proposals/<PRP> under the accepting human, opens the PR on GitHub (code owners review; the console never merges it) or records the branch locally, and marks the proposal accepted with a 'pending review' chip until the default branch carries the line; Dismiss stays reason-required; skills show version, backed-by (hook chip, advisory amber, unknown hook flagged), findings citing and pass % from trigger-test cases (evals/cases with skill:<name>, run by the suite; sdlc evals trigger <skill> --prompt is the check), below thresholds.skillPassThreshold amber + triage 'skill not triggering'; CLI proposal accept|dismiss and evals trigger exist; build/test/lint green"
schema: 1
---
# Plan: CLAUDE.md repeat-mistake proposals, skills pass % and backed-by (2.8) (from spec.md n/a)

## Files that change
packages/schemas/src/proposal.ts
packages/schemas/src/evals.ts
packages/schemas/src/config.ts
packages/schemas/json/*.schema.json
packages/core/src/config.ts
packages/core/src/proposals.ts (new)
packages/core/src/skills.ts (new)
packages/core/src/evals.ts
packages/core/src/repo.ts
packages/core/src/transitions/proposal.ts
packages/core/src/transitions/evals.ts
packages/core/src/validate/rules.ts
packages/core/src/index.ts
packages/core/test/proposals.test.ts (new)
packages/core/test/transitions.test.ts
packages/mcp/src/sessions.ts
packages/mcp/src/tools.ts
packages/mcp/src/context-bundle.ts
packages/mcp/test/tools.test.ts
packages/mcp/test/index.test.ts
packages/server/src/sessions/registry.ts
packages/server/src/sessions/launcher.ts
packages/server/src/sessions/prompts.ts
packages/server/src/engine/engine.ts
packages/server/src/engine/jobs.ts
packages/server/src/engine/proposals.ts (new)
packages/server/src/engine/index.ts
packages/server/src/proposals.ts (new)
packages/server/src/actions.ts
packages/server/src/http.ts
packages/server/src/snapshot.ts
packages/server/src/index.ts
packages/server/test/proposals.test.ts (new)
packages/server/test/serve.test.ts
packages/server/test/suite.test.ts
packages/cli/src/commands/proposal.ts (new)
packages/cli/src/commands/evals.ts
packages/cli/src/main.ts
packages/cli/test/cli.test.ts
packages/web/src/views/Config.tsx
packages/web/src/app.tsx
packages/web/test/render.test.tsx
fixtures/src/seed.ts
fixtures/seed/** (generated)
fixtures/test/seed-sync.test.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Schemas: proposal gets `reason` (normalised repeat reason) and `pr.branch`; text is one line; eval case gets `skill` (trigger test); `thresholds.skillPassThreshold` (default 0.8).
2. Core: `repeatSignals` (hook.blocked reasons + gate.sent_back feedback, lowercase/trimmed, ≥2 occurrences from distinct sessions/decisions, linked to the proposal carrying the reason); `appendClaudeMdLine`; `fileProposal` (agent-reported, system-committed; refused while a proposal for the reason exists); `acceptProposal` (eng/platform; records branch/PR, status accepted); `skillStatus` (version, backed-by resolution against settings, findings citing, pass % from the latest complete run's trigger tests); eval signal `skill` → triage tier `skill-trigger`; warning `skill.backed-by.unknown`; validation warning `proposal.reason-duplicate`.
3. MCP: `propose_claude_md_line` keeps the draft beside the session; the propose job's tool list.
4. Server: session kind `propose` (branch `sdlc/propose/<CHG>`, read-only, ledger on the default branch, prompt with the cluster and the word budget); engine launches one job per pending signal (`proposal:<reason key>`) and mirrors the draft into `sdlc/proposals/` when the session ends; `acceptProposalAction` commits the line on `sdlc/proposals/<PRP>` as the human, opens the PR on GitHub or records the branch locally, then marks the proposal; snapshot carries `repeatSignals` and `skillStatus`; routes.
5. CLI `sdlc proposal accept|dismiss <PRP> [--reason]`, `sdlc evals trigger <skill> --prompt <text>` (runs the harness headless; exit 0 iff the Skill tool loaded it), `sdlc session start --kind propose`.
6. Web: Config "Repeat mistakes" panel, proposal Accept with the PR/branch chip, skills columns.
7. Seed: a second "test freeze active" block (CHG-0017), PRP-0007 carries the reason, CASE-0004 brand trigger test in RUN-0001.
8. Tests, decisions, build-order tick.

## Risks
- The console never edits CLAUDE.md on the default branch: the accepted line lives on a proposal branch under the human's identity and reaches the default branch only through the PR the code owners merge.
- A propose session runs on a change's ledger (the newest citation) because sessions are change-scoped; its branch is throwaway and it commits nothing.
- The trigger-test runner needs the harness; without it the check fails honestly and the pass % shows it.

## Proof
- core: signals across changes, dedupe against an existing proposal, accept/dismiss refusals, skill pass % and backed-by resolution, skill triage signal.
- mcp: twelve tools; the draft written by `propose_claude_md_line`.
- server: engine launches one propose job per pending signal with the fake harness, the mirror files the proposal, a third occurrence files no second one; accept creates the branch with the line and marks the proposal (local mode); GitHub accept opens a PR through the fake API.
- cli: wiring and usage; `evals trigger` with the fake harness.
- web: seed Config shows the repeat signal, the proposal's Accept, the brand pass %.

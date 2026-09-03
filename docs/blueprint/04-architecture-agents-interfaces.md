## 7. Proposed Architecture

Layering (dependencies point downward only):

```
UI (console SPA)   CLI (human)   MCP server (agents)   Hook entry points   Webhook receivers
        └──────────────┴──────────────┴──────────────────┴──────────────────┘
                              Server / Application layer
                 (HTTP+WS, job queue, lifecycle engine, session observer)
        ┌──────────────┬──────────────┬──────────────────┬──────────────────┐
   Core domain     Validation     Context builder    Metrics engine    Adapters (git, code host,
   (parse/derive)  engine                                                 CI, records/MCP, scanner,
                                                                          harness launcher, OTel)
```

### 7.1 Core domain library (`@sdlc/core`)
- **Responsibility:** pure functions over a filesystem snapshot: parse `sdlc/` tree and config files into entities; derive `ChangeView`, gate queues, badges, eligibility, `planMatches`; compute transitions (`applyAccept`, `applySendBack`, `applyLoop`, `createChange`) as *plans of file writes + events*, not side effects.
- **Inputs:** a `Tree` abstraction (path → content + SHA), identity, clock.
- **Outputs:** typed entities, `ChangeView[]`, `WritePlan{files[], events[], commitMessage}`.
- **Dependencies:** schema layer only. No git, no network, no I/O.
- **Interfaces:** `loadRepo(tree)`, `deriveChange(id)`, `deriveAll()`, `plan.accept(changeId, gate, actor)`, `plan.sendBack(...)`, `plan.createChange(origin, intent)`, `plan.confirmTasks(...)`, `plan.confirmRepro(...)`, `eligibility(changeId)`, `gateDefs`.

### 7.2 Schema / parser layer
- **Responsibility:** JSON Schemas for `change.yaml`, `tasks.yaml`, `log.jsonl` events, eval case/run, triage, finding, proposal, config; markdown front-matter + section parsers for `intent.md`, `spec.md`, `plan.md` (files list, acceptance line), `CLAUDE.md` (Commands / Verifying block, word count), `SKILL.md` front-matter, `.claude/agents/*.md`, `settings.json` hooks, `bands.yaml`.
- **Outputs:** typed objects + structured diagnostics `{path, line?, severity, message}`.
- **Interfaces:** `parse<Entity>(text) → Result`, `schemas` exported for MCP tool schemas and UI forms.

### 7.3 Validation engine
- **Responsibility:** rule catalogue (§11) evaluated over entities: schema, completeness, SHA chaining, transition preconditions, immutability of `risk/kind`, freeze/plan-sync checks, hook config lint, eval-suite health, link checks, staleness.
- **Inputs:** entities + a proposed `WritePlan` (for pre-commit) or the whole tree (for `sdlc validate`).
- **Outputs:** `Diagnostic[]` with `blocking: boolean`.
- **Interfaces:** `validateTree()`, `validateWritePlan(plan)`, `check.planSync(diffFiles, plan)`, `check.testFreeze(path, change)`, `check.verifyBeforeDone(session)`.

### 7.4 Lifecycle engine
- **Responsibility:** react to triggers (gate accepted, session done, eval green/red, PR merged, band breached, scan finished, schedule) and enqueue `AgentJob`s or system jobs with idempotency keys; track job state; write `stage.entered` events; run write-backs with retry.
- **Inputs:** event stream from watcher/webhooks/CLI; core derivations.
- **Outputs:** jobs to the harness launcher / CI adapter; events; notifications to UI.
- **Dependencies:** core, context builder, adapters, job queue.
- **Interfaces:** `on(trigger, handler)`, `enqueue(job)`, `jobs.list/get/retry/cancel`.

### 7.5 Artifact store / git integration
- **Responsibility:** the only component that writes to the repo. Applies `WritePlan`s as commits (author = acting identity, trailer `SDLC-Event: <ulid>`), reads trees at arbitrary refs, lists branches/worktrees, computes diffs for plan-sync, manages worktree creation/removal, reads `log.jsonl` across branches (union), applies `.gitattributes` merge drivers.
- **Inputs:** `WritePlan`, ref, identity.
- **Outputs:** commit SHA; `Tree` snapshots.
- **Interfaces:** `readTree(ref)`, `commit(plan, identity, {branch})`, `diffFiles(from,to)`, `worktree.add/remove/list`, `log(path)`, `blame` (for author/timestamps).

### 7.6 Code-host adapter (GitHub first; interface allows GitLab)
- **Responsibility:** open PRs for artifacts and code, read PR state/reviews/checks/findings, merge on gate 5 (respecting branch protection), publish check runs (evidence, eval verdict, severity tally), receive webhooks (PR opened/merged/review, check completed, push), look up code owners.
- **Interfaces:** `pr.open/get/merge/requestChanges/comment`, `checks.publish`, `codeowners(path)`, `webhooks.verify+dispatch`.

### 7.7 CI adapter
- **Responsibility:** trigger and observe eval-suite runs and per-change runs when execution happens in CI (workflow dispatch), read logs/artifacts, map run results into `EvalRun`/`PerChangeRun` files (the CI job itself commits or uploads them). Local runner alternative executes the same steps on the engineer's machine for local mode.

### 7.8 Harness launcher (agent orchestration, not inference)
- **Responsibility:** start/stop harness sessions according to job kind and mode: interactive Claude Code in a worktree (`claude --worktree <name>` with plan/auto permission mode), headless `claude -p` with `--allowedTools` from the manifest, or an Agent SDK service call; inject context via manifest (files copied/linked, prompt from template, MCP server address); register the session; forward events.
- **Interfaces:** `launch(job, manifest) → sessionId`, `message(sessionId, text)` (add guidance), `stop`, `takeOver` (release worktree to human), capability discovery (`supportsPlanMode`, `supportsHooks`).
- **Model-agnosticism:** the launcher speaks a *harness contract* (§8.9); Claude Code is the first implementation.

### 7.9 Session observer / event ingestion
- **Responsibility:** consume hook callbacks (`sdlc hook …` invocations), MCP `report_*` calls, harness JSONL transcripts and OTel exports; maintain the session registry; detect stalled/flaky/heartbeat loss; mirror summary events into `log.jsonl` via the artifact store (on the session's branch).
- **Outputs:** Session records (C), events (G summaries).

### 7.10 Context builder
- **Responsibility:** assemble per-stage bundles deterministically (§8.3); produce `ContextManifest` with SHAs; enforce allowed-tools and deny lists from managed settings; render prompt templates (design pass, plan interview, split proposal, review, diagnose, CLAUDE.md proposal).
- **Interfaces:** `build(job) → {files, prompt, allowedTools, mcpServers, manifest}`.

### 7.11 Metrics engine
- **Responsibility:** metric definitions (name, stage, leading/lagging, sources, window) → values + trend; snapshot cache; detection-script input (control bands read snapshots).
- **Interfaces:** `compute(metric, window)`, `snapshot()`, `trend(metric)`.

### 7.12 Records / integration adapters (MCP clients)
- **Responsibility:** read external records (Jira/ServiceNow/requirements tool), write back on accept, maintain link fields; scanner ingestion (Claude Security webhook/CSV/MD); channel triggers (Claude Tag → triage item); deployment MCP tools (deploy/status/rollback per environment) surfaced to headless agents only through the manifest.
- **Interfaces:** `record.get/link/writeBack`, `scanner.ingest`, `triage.fromChannel`, `deploy.tools(env)`.

### 7.13 Server / application layer
- **Responsibility:** host everything above in one process for local mode (`sdlc serve`): HTTP API + WebSocket/SSE for the UI, MCP server endpoint, webhook receivers, file watcher (repo + `sdlc/` + `.claude/`), job queue (in-process, persisted to cache), identity (local git identity; OIDC in hosted mode).

### 7.14 CLI (`sdlc`)
- Human-facing commands mirroring UI actions and administrative tasks (§9.1); also the entry point hooks call (`sdlc hook <name>`), so hooks and console share one code path.

### 7.15 MCP server (`sdlc-mcp`)
- Agent-facing tools (§9.3): discover work, get context, propose artifacts, report rounds/results, request input, log decisions. No accept tool exists.

### 7.16 UI (console SPA)
- Single-page app per spec §3–§4 and §6; subscribes to derived state; issues actions; holds `UIState` only.

### 7.17 Search / indexing
- Small: full-text over artifacts, ids and titles for the board/gates/evals filters. Implemented over the cache; not a separate service.

### 7.18 Audit trail
- Not a subsystem — it is `git log` + `log.jsonl` + PR history + OTel. The console provides `sdlc audit <change>` that renders the chain (who asked, what the agent produced, who approved) and verifies SHA chaining.

---

## 8. Agent Architecture

### 8.1 Two layers, kept apart
- **Orchestration** (console): decides *that* work exists, *what* context it gets, *which tools* it may use, *where* its output goes, and *records* what happened. Deterministic, testable without a model.
- **Inference** (harness + model): produces the artifact. Replaceable. The console records `model` in every manifest and fingerprint precisely because it is a variable.

### 8.2 Work discovery and assignment
- Work exists when a change's derived view says an artifact is awaited (`agent=true`) or a job is queued. Discovery interfaces: MCP `list_work({stage?, changeId?, role?})` and CLI `sdlc work list`.
- **Assignment:** jobs are created by the lifecycle engine on transitions; a job carries `assignee` (engineer from config/claim, or `headless`). Interactive jobs (plan session, build session) are *claimed* by an engineer (`sdlc work claim`), which launches the harness on their machine; headless jobs (design pass, review, diagnose, eval run, CLAUDE.md proposal) launch on CI/service without a person in the path.
- Only one running job per `(change, cycle, stage, task)`; idempotency key enforced in the queue.

### 8.3 Context assembly (per job kind)

| Job | Files (with SHA) | Prompt template | Allowed tools (headless) | Output contract |
|-----|------------------|-----------------|--------------------------|-----------------|
| design-pass | `intent.md`, org skills (brand/security/compliance/UX), `sdlc/templates/spec.md`, mock if present | PB-S2 prompt (verbatim intent, demand flagged concerns) | Read, Skill, Write(`spec.md` only) | `spec.md` with front-matter `intent_sha`, `skills[]`, `concerns[]`, `prompt_ref` |
| plan-session | `intent.md`, `spec.md`, `CLAUDE.md`, skills, subagents, repo (plan mode = read-only) | PB-S3 step 2 (files, order, tests) + interrogation prompts | harness plan mode (no edits) | `plan.md` draft revisions; `plan.final` event |
| split-proposal | accepted `plan.md`, thresholds | "propose tasks; merge overlapping file sets; prefill target from acceptance line" | Read only | `tasks.yaml` (state proposed) |
| build-session | worktree, `plan.md`, `spec.md`, `CLAUDE.md`, verification contract, task target, mock, repro block | harness default with `CLAUDE.md`; done rule | per managed/team settings; `Bash(make test/build/lint)`, Edit within worktree; deny tests under freeze | rounds; done only when green; commits on task branch |
| eval-run (per change) | worktree head, intersecting cases, verification commands, config fingerprint | none (deterministic runner; cases are prompts to a *fresh* headless agent when a case needs one) | `Read,Edit,Bash(make test)` as in playbook YAML | `run-<n>.json`, evidence |
| review | PR diff, `REVIEW.md`, `spec.md`, `plan.md`, `planMatches`, repro proof | `REVIEW.md` passes | read + PR comment + push to PR branch | findings (severity, pass), tally check run |
| claude-md-proposal | repeat-reason cluster, current `CLAUDE.md`, word budget | "propose one line that would have prevented these" | Read | proposal file |
| diagnose (2σ) | snapshot, bands, tools from `bands.yaml` | PB-S6 step 5 (intent format) | exactly `tiers.2sigma.tools` | triage item (read-only diagnosis) |
| propose (3σ) | as above + routes | as above | PR route or runbook route only | triage item + PR / runbook invocation record |

Manifests are hashed; the hash is written into the produced artifact's front-matter (`context_manifest`) so a session can be reproduced from the same tree + manifest + model pin.

### 8.4 Receiving requirements and constraints
- Requirements arrive as files, never as chat memory: the agent reads `intent.md`/`spec.md`/`plan.md` from the bundle. Constraints arrive as (a) skills (advisory), (b) `CLAUDE.md` (working knowledge), (c) hooks and permission settings (deterministic), (d) the task `target` (done criterion), (e) `bands.yaml` tiers (Maintain).

### 8.5 Tools the agent may invoke
- Harness-native: Read/Edit/Bash within permission rules; subagents from `.claude/agents/`.
- Console MCP tools (§9.3): `list_work`, `get_change`, `get_context`, `propose_artifact`, `submit_plan_revision`, `propose_tasks`, `report_round`, `report_verifier`, `report_done`, `request_input`, `log_note`, `propose_test_change`, `propose_claude_md_line`, `create_triage_item`.
- Deployment MCP tools per environment (dev free, staging limited, production prepare-only) — exposed only to CI/service identities.
- Explicitly absent: any accept/merge/approve tool; any tool that edits `change.yaml.risk/kind`; direct push to default branch.

### 8.6 Proposing changes
- Artifacts: written to the change directory on the job's branch/worktree; in GitHub mode surfaced as a PR whose merge is the gate. `propose_artifact` validates schema before committing and returns diagnostics to the agent so it can fix the artifact itself.
- Code: commits on the task branch; `plan-sync` hook blocks out-of-plan files; PR opened by the system after green evals, never by the agent directly to main.
- Configuration: agents never edit `CLAUDE.md`/skills/hooks directly; they file proposals that humans turn into PRs.

### 8.7 Recording decisions and results
- Every agent action of lifecycle significance is an event with `actor.type=agent` and `session` id: drafts, questions answered, rounds, verifier results, hook blocks, done reports, proposals. Full transcripts stay in the harness's own JSONL/OTel export, referenced by `transcriptRef`; the console links, does not copy.
- Results: literal command outputs stored as evidence (final round, run results). The console displays them verbatim (P5).

### 8.8 Verification
- In-session feedback loop (many rounds) and end-of-session verifier subagent (one fresh-context check) are separate objects and both recorded. `verify-before-done` makes green mandatory. Per-change eval run is a third, system-owned check. Stage 5 review is a fourth (agent) plus human judgment. None of the agent checks can approve.

### 8.9 Preventing self-approval (structural, not policy)
1. No accept/merge capability exists on the MCP surface or in headless CLI mode; `sdlc accept` requires an interactive human identity (and in hosted mode an authenticated principal whose roles own the gate).
2. In GitHub mode the accept is a merge that branch protection requires a code owner to approve; the agent's identity (bot/app) is never a code owner.
3. Production deploy requires a `RELEASE_APPROVAL` supplied through the hook by a human identity; the agent identity cannot set it.
4. Validation engine rejects any `gate.accepted` event whose actor is not human — even if hand-written into `log.jsonl` — and `sdlc validate` runs in CI on every PR touching `sdlc/`.
5. Session identity is separate from engineer identity; both are logged; the harness runs under the agent identity in CI.

### 8.10 Reproducibility and audit of sessions
- Inputs: tree SHA + manifest hash + model pin + prompt template ref (all in the artifact front-matter and the job record).
- Process: harness transcript (OTel/JSONL) referenced from the session record; hook decisions in `log.jsonl`.
- Output: artifact SHA, run results, PR.
- `sdlc audit <change>` reconstructs the chain and flags any break (missing manifest, actor violations, SHA mismatch).

### 8.11 Model- and harness-agnosticism: the harness contract
A harness implementation must be able to: (1) start with a working directory and a file bundle; (2) accept a prompt and an allowed-tools list; (3) run in a read-only "plan" mode or refuse the plan-session job kind; (4) call the console MCP tools or emit equivalent events via hook scripts; (5) honour block/allow decisions from pre-action hooks (or the console falls back to review-time checks as the spec's test-freeze fallback describes); (6) report a model identifier. Claude Code satisfies all six natively; a harness lacking (3) or (5) is supported with degraded guarantees, which the Config view must display ("hooks not enforced by harness — review-time fallback active").

---

## 9. APIs, CLI, and Agent Interfaces

### 9.1 Human-facing CLI (`sdlc`)

| Command | Parameters | Output | Errors | Permission | Caller |
|---------|-----------|--------|--------|------------|--------|
| `init` | `--product`, `--intent-home` | created paths | exists / not a git repo | anyone | platform |
| `serve` | `--port`, `--role po\|eng`, `--open` | URL | port in use | anyone | any human |
| `validate` | `[--ref] [--json]` | diagnostics | exit 1 on blocking | anyone / CI | human, CI |
| `change new` | `--title --kind --risk --origin --intent <file\|->` | id | schema errors | PO/eng | human |
| `change list/show` | filters, `--json` | views | — | anyone | human, scripts |
| `accept` | `<CHG> --gate n [--message]` | commit/merge SHA | not owner; validation; branch-protection | gate owner (human, interactive) | human |
| `send-back` | `<CHG> --gate n --feedback <text>` | event id | empty feedback | gate owner | human |
| `loop` | `<CHG> --incident <file>` | cycle n+1 | not at stage 6 | PO | human |
| `tasks confirm` | `<CHG> [--edit]` | worktrees created | overlapping files unmerged | engineer | human |
| `session start/list/message/stop/takeover` | `--task --target --mode` | session id | no target; mode > eligibility; backlog ceiling | engineer | human |
| `repro confirm/reject` | `<CHG> [--reason]` | sha | no repro drafted | engineer | human |
| `freeze lift` | `<CHG> --file <path> --reason` | event | already lifted | engineer | human |
| `triage accept/dismiss` | `<TRI> [--reason --tune]` | new CHG id | missing item | PO/service owner | human |
| `security patch/escalate/dismiss` | `<SEC> [--reason]` | status / CHG id | not "new" | security lead / eng | human |
| `proposal accept/dismiss` | `<id>` | PR url | — | owner per config | human |
| `evals run` | `[--manual]` | run id | budget exhausted / mode scheduled | platform | human |
| `evals harvest` | `<CHG>` | draft case id | not merged | anyone | human |
| `audit` | `<CHG> [--json]` | chain report | breaks listed | anyone | human, auditor |
| `metrics` | `[--stage] [--window 30d]` | table | source missing | anyone | human |
| `hook <name>` | reads harness JSON on stdin | exit 0/2 + message | — | harness | hooks |
| `work list/claim` | `--stage --mine` | jobs | already claimed | engineer | human |

All commands support `--json`; mutating commands require a resolvable git identity and refuse when `SDLC_ACTOR_TYPE=agent` (set by the launcher in headless sessions).

### 9.2 Internal HTTP API (server ↔ UI; same shapes as CLI `--json`)
- `GET /api/state` → full derived snapshot `{changes[], triage[], findings[], sessions[], config, evals, metrics, identity, validation}`; `WS /api/events` streams `{type: 'snapshot'|'patch'|'toast', …}` on every recomputation.
- `POST /api/changes/:id/accept|send-back|loop`, `POST /api/changes`, `POST /api/changes/:id/tasks/confirm`, `/repro/confirm|reject`, `/freeze/lift`, `/mode` (downgrade), `/harvest`; `POST /api/triage/:id/accept|dismiss`; `POST /api/findings/:id/patch|escalate|dismiss`; `POST /api/proposals/:id/accept|dismiss`; `POST /api/evals/run`; `POST /api/sessions` (+ `/message`, `/raise-cap`, `/takeover`, `/stop`).
- Errors: `409` (precondition/validation, body = diagnostics), `403` (role), `502` (adapter failure, e.g. merge refused by branch protection, write-back failed — with `retryable: true`).
- Identity: local mode = git identity + role switcher; hosted mode = session cookie/OIDC, role switcher restricted to held roles.

### 9.3 MCP / agent tools (`sdlc-mcp`)

| Tool | Params | Returns | Errors | Notes |
|------|--------|---------|--------|-------|
| `list_work` | `stage?, changeId?` | jobs/changes awaiting artifacts | — | discovery |
| `get_change` | `id` | `ChangeView` minus human-only fields | not found | |
| `get_context` | `jobId` | bundle listing + manifest hash | job not running | files already on disk in worktree; tool returns paths |
| `propose_artifact` | `changeId, index, body, frontMatter` | validation diagnostics; sha on success | schema fail; index not awaited | writes on job branch; never to default branch |
| `submit_plan_revision` | `changeId, body, final: bool` | rev n | not in plan stage | `final=true` opens gate 3 |
| `propose_tasks` | `changeId, tasks[]` | proposal id | overlaps unmerged | |
| `report_round` | `sessionId, results[], screenshot?, diffPct?` | loop state | unknown session | flaky/stalled computed server-side |
| `report_verifier` | `sessionId, ran, saw, mismatch` | ok | | |
| `report_done` | `sessionId, evidenceRef` | accepted / **blocked** with reason | last round not green | mirrors `verify-before-done` |
| `request_input` | `sessionId, question` | ack | | sets waiting-on-you |
| `log_note` | `changeId, text` | event id | | |
| `propose_test_change` | `changeId, path, diff, reason` | proposal id | freeze not active | |
| `propose_claude_md_line` | `text, citations[]` | proposal id | | |
| `create_triage_item` | `tier, src, title, evidence, intentBody` | TRI id | tier not permitted for caller | Maintain tier tools |
| `deploy_*` (env-scoped) | `env, version` | status | hook block | only in CI/service identity |

No tool accepts, merges, approves, lifts freeze, confirms repro, or edits risk/kind. Tool schemas are generated from the schema layer.

### 9.4 Hook entry points (filesystem/process interface)
`.claude/hooks/plan-sync.sh`, `test-freeze.sh`, `verify-before-done.sh`, `production-gate.sh` — thin wrappers that pipe the harness's JSON to `sdlc hook <name>`; exit 2 blocks with a message to the agent; every decision logged. Installed by `sdlc init` into `.claude/settings.json` (team scope); organisations promote them to managed settings outside the console.

### 9.5 Webhooks (inbound)
- Code host: PR opened/synchronize/review/merged, check run completed, push to default branch.
- CI: eval run finished (or CI commits the run file; both supported).
- Scanner: finding created/updated.
- Channel (Claude Tag) / detection script: triage item created.
All verified by signature; payloads are treated as data; the engine derives everything from git after refreshing.

### 9.6 Filesystem interface
The `sdlc/` tree and `.claude/` are themselves an interface: any tool (including a human with an editor) may write valid files; `sdlc validate` and the watcher pick them up. This is how non-console agents and the claude.ai/Cowork git connector participate.

---


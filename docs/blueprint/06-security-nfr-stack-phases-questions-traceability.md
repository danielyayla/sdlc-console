## 13. Security and Permissions

| Boundary | Requirement | Mechanism |
|----------|-------------|-----------|
| Agent write access | Agents write only within their worktree/branch and the change directory on that branch; never to the default branch, `sdlc/config.yaml`, `change.yaml.risk/kind`, tests under freeze, or `CLAUDE.md`/skills/hooks. | Branch protection; managed permissions (`allow`/`deny`); hooks; MCP tool surface (§9.3); validator rejects agent-authored decision events. |
| Human approval | Gate acceptance, repro confirm, freeze lift, task confirm, proposal accept, triage/finding decisions, release authorization require an interactive human identity holding the role. | CLI refuses under agent env; server checks identity → roles; GitHub merge requires code owner; production hook requires `RELEASE_APPROVAL` from a human. |
| Destructive actions | Worktree removal, cycle archival, case retirement, finding dismissal are recorded and reversible via git; the console never force-pushes, rewrites history or deletes files outside `sdlc/`. Rollback is a pre-approved runbook, rehearsed in staging, invoked only at 3σ or by a human. | Write plans are additive; `sdlc` has no `--force`; runbook allowlist in `bands.yaml`. |
| Project access | Local mode = filesystem access to the clone; hosted mode = code-host repository permissions are the authority (read → view, write → engineer actions, code owner → merges), mapped to roles in `sdlc/config.yaml`. | Code-host adapter permission lookup; no separate ACL store. |
| Secret handling | The console holds no long-lived production secrets. Code-host/CI/scanner tokens come from the environment or OS keychain, scoped and short-lived where the platform allows; secrets never enter manifests, artifacts, `log.jsonl`, evidence excerpts (redaction pass on outputs) or MCP responses. Agent sessions inherit the managed `permissions.deny` for `.env*`, `secrets/**`, and credential files. | Redaction filter on evidence ingestion; manifest builder strips env; managed settings snapshot displayed read-only. |
| External integrations | Write-back to Jira/ServiceNow goes through MCP connectors owned by the platform team; failure is non-fatal and visible. Inbound webhooks are signature-verified and treated as data (P: instruction-source boundary). Deployment MCP tools are per-environment allowlists exposed only to CI/service identities. | Adapter layer; `allowManagedMcpServersOnly` in managed settings. |
| Hosted / team mode | Adds authentication (OIDC/SSO), identity → role mapping, a server-side cache and job queue, and audit export (OTel/compliance API). It adds no new source of truth. | Deferred phase (§16), designed for from the start by keeping identity a parameter of every write plan. |

---

## 14. Non-Functional Requirements

| Area | Requirement |
|------|-------------|
| Reliability | Every mutation is an atomic git commit or an idempotent external call with retry; a crash mid-transition leaves either the old or the new committed state, never a partial one. Job queue persisted in the cache and replayable. |
| Determinism | Given the same tree SHA, config and cache-independent inputs, `deriveAll()` returns identical output (golden tests over fixture repos including the spec's seed scenarios and acceptance checks a–n). Hooks are pure over their inputs. |
| Performance | Derivation for a repo with 1,000 changes and 50 sessions < 500 ms warm (incremental recompute per changed path); UI first paint < 1 s on local mode; watcher debounce 100–250 ms; large evidence files streamed, capped (e.g. 1 MB inline, rest by link). |
| Portability | macOS/Linux/Windows (WSL) for local mode; git ≥ 2.40 for worktrees/merge drivers; code-host adapter interface allows GitHub → GitLab; harness contract allows non-Claude harnesses with degraded guarantees. |
| Offline / local | Pipeline, Change detail, Gates, Sessions (local harness), Config, local per-change runs and validation work with no network; Loop/Security/eval-suite/records show "not connected" states rather than failing. |
| Scalability | Monorepo with multiple products; hundreds of concurrent sessions across a team in hosted mode; cache sharded per product; webhooks fan-in through one queue. |
| Observability | Structured logs; OTel spans for jobs, hooks and adapters; metrics engine exposes its own health (source freshness); `sdlc doctor` checks git, hooks installation, harness availability, adapters. |
| Testability | Core is I/O-free; fixture repos as golden tests; adapter fakes (in-memory code host, fake harness that emits scripted events); UI tested against recorded snapshots; hooks tested with recorded harness JSON. |
| Extensibility | New artifact templates and metrics via config/code registration; new job kinds via the lifecycle engine registry; harness and code-host adapters behind interfaces; skills/agents/hooks/MCP through the harness's own mechanisms (P12). |
| Backwards compatibility | `schema` version on every file; migrations are explicit `sdlc migrate` steps that produce a reviewable commit; the console reads N-1 schema versions. |

---

## 15. Technology Decisions

| Decision | Recommendation | Alternatives | Trade-offs | Why it fits |
|----------|----------------|--------------|-----------|-------------|
| Language / runtime | **TypeScript on Node ≥ 22** for core, server, CLI, MCP server, hooks entry point; shared types with the UI. | Go (single binary, fast hooks); Python (FastMCP, data tooling); Rust. | Node hook start-up (~50–100 ms) is slower than Go; acceptable for edit/commit/stop hooks. Go would split types from the UI. | One language across core/UI/MCP; the MCP TypeScript SDK and Claude Code ecosystem (`claude-code-action`, plugins) are Node-native; schema → types → MCP tool schemas in one pipeline. |
| Repository layout | pnpm monorepo: `core`, `schemas`, `adapters/*`, `server`, `cli`, `mcp`, `web`, `hooks`. | Separate repos. | More tooling up front. | Enforces the dependency direction in §7. |
| Git access | **CLI `git` via a thin wrapper** (worktrees, merge drivers, blame) with isomorphic-git only if a no-git environment is ever required. | libgit2 bindings; isomorphic-git everywhere. | Spawning git is slower than libgit2 but dependency-free and identical to what the harness uses. | Worktrees and merge drivers are first-class only in real git. |
| Code host | **GitHub App + REST/GraphQL + webhooks**; adapter interface. | GitLab first. | GitHub-only initially. | Playbook's reference integrations (claude-code-action, Code Review, Claude Security GitHub App). |
| Schema / validation | **JSON Schema (2020-12) via Ajv + zod-derived types**; YAML front-matter with `gray-matter`. | zod only; protobuf. | Two representations to keep aligned (generate one from the other). | JSON Schema doubles as MCP tool schema and as documentation for non-console writers. |
| Cache | **SQLite (better-sqlite3) file in `.sdlc-state/`**, rebuildable. | JSON files; LevelDB. | Native module. | Sessions/telemetry/metrics need indexed queries; disposable so it isn't a second truth. |
| UI | **React + Vite, plain CSS variables** (no component framework), Source Sans 3 / JetBrains Mono. | Svelte/Solid; Tailwind. | Hand-written CSS for a dense terminal-style UI is less work than fighting a framework's defaults. | Spec §6 tokens map directly to CSS variables; single view enum, no router needed. |
| Server ↔ UI transport | **HTTP JSON + WebSocket snapshot/patch**. | SSE; tRPC. | WS needs reconnection logic. | Bidirectional; low latency for session pulses. |
| Desktop packaging | **None in MVP**: `sdlc serve` + browser. Later optional Tauri/Electron wrapper. | Electron first. | Packaging effort deferred. | Spec is a web console; local server already gives local-first. |
| Agent protocol | **MCP (stdio + HTTP)** server exposing §9.3 tools; hooks as shell → `sdlc hook`. | Custom REST for agents. | MCP adds a dependency but is what every listed harness speaks. | Playbook references MCP for connectors and deployment; Claude Code consumes it natively. |
| Harness launcher | **Claude Code CLI adapter** (interactive via terminal spawn/`--worktree`, headless via `claude -p --output-format json --allowedTools …`), **Agent SDK adapter** for services. | Direct API calls. | Coupled to CLI flags; versioned adapter. | Keeps inference outside; matches playbook usage exactly. |
| Job queue | **In-process queue persisted to SQLite** (local); pluggable to Redis/BullMQ for hosted. | Temporal. | Overkill until hosted. | Idempotency keys are the important part; the queue is simple. |
| CI | **GitHub Actions workflows generated by `sdlc init`** (evals on `CLAUDE.md`/`.claude/**`, per-change run, validate on PR). | GitLab CI templates later. | — | Playbook YAML is the template. |
| Telemetry | **OpenTelemetry** (export from harness + console spans). | Custom logs. | — | Playbook names OTel as the logging channel. |
| Metrics sources | git log + ledger (built-in), GitHub PR metadata, CI API, incident/triage records; Prometheus optional for bands. | — | Missing sources degrade gracefully. | Playbook's measures are all derivable from these. |

---

## 16. Implementation Phases

Dependencies are listed as *needs:*.

### Phase 0 — Foundation (needs: nothing)
1. Monorepo, schemas (`change.yaml`, events, config, eval case/run, triage, finding, proposal), front-matter/markdown parsers (intent/spec/plan/CLAUDE.md/SKILL.md/agents/settings/bands).
2. Core derivation (`deriveAll`), gate defs, transition write-plans, validation engine with the blocking rules from §11.1.
3. Git adapter (tree read at ref, commit write-plan with identity, diff files, worktrees, union merge driver, log/blame).
4. `sdlc init`, `sdlc validate`, `sdlc change new/list/show`, `sdlc accept/send-back/loop`.
5. Fixture repos reproducing the spec's seed data (8 changes, 2 triage, 3 findings, 4 sessions) and golden tests for acceptance checks (a)–(f).

### Phase 1 — MVP: the smallest complete loop (needs: Phase 0)
6. Server (`sdlc serve`): watcher, snapshot/patch WS, HTTP actions, local identity + role switcher (`defaultRole`).
7. UI: Top bar, Pipeline, Change detail (stepper, viewer, gate/no-gate panel, activity), Gates queue, Loop (triage accept/dismiss from files), Security (file-backed findings + CSV/MD import), Metrics from git+ledger only; visual tokens.
8. Hooks: `plan-sync`, `test-freeze`, `verify-before-done` via `sdlc hook`; `.claude/settings.json` installed by init.
9. MCP server: `list_work`, `get_change`, `get_context`, `propose_artifact`, `submit_plan_revision`, `report_round`, `report_done`, `request_input`, `log_note`.
10. Harness launcher for Claude Code (plan session, build session in worktree) + session observer (registry, rounds, stalled/flaky, heartbeat); Sessions view.
11. Lifecycle engine (local): gate accept → job enqueue; session done → local per-change run (verification commands + intersecting cases) → green opens PR (GitHub adapter minimal: open PR, read merge state) → stage 5; merge → stage 6; loop → cycle+1 with INC draft case.
12. Config view read-only (CLAUDE.md, verification block, subagents, skills, hooks with lint), eval cases table read-only.
*Exit criterion:* one change can travel 1→6→1 with real files, real hooks and a real Claude Code session, all evidence in git, `sdlc audit` clean.

### Phase 2 — Next (needs: Phase 1)
13. GitHub mode fully: artifact PRs as gates, merge via API under branch protection, review findings mirror, check runs (evidence, severity tally, eval verdict), webhooks; high-risk tech-lead-via-PR routing.
14. Eval suite in CI: generated workflows, config-change gate, run history strip, budget/incomplete, harvest actions, retire/broken-check signals → triage.
15. Task split proposal + confirm, capacity ceiling, auto-eligibility with verification term, AUTO→SUPERVISED override, visual rounds strip with mock comparison.
16. Repro-first fix flow end-to-end, freeze lift once, fallback auto-finding, PR repro proof.
17. CLAUDE.md repeat-mistake proposals; skills pass % from trigger-test set; backed-by column.
18. Records mode (`external`/`linked`) with MCP write-back and retry.
19. Metrics from PR/CI/incident sources; trend chips.

### Phase 3 — Later (needs: Phase 2)
20. Hosted/team mode: OIDC identity, role restriction of the switcher, server-side cache/queue, multi-repo/monorepo product switching, OTel/compliance export.
21. Maintain automation: detection script package, `bands.yaml` tiers → headless diagnose/propose jobs, runbook allowlist, Claude Security webhook ingestion, Claude Tag channel triage.
22. Deployment MCP tools per environment, production-gate hook wiring, `deploy.yaml` records, rollback rehearsal check.
23. GitLab adapter; non-Claude harness adapter with degraded-guarantee display; optional desktop wrapper; drag-free board remains (spec forbids drag-and-drop).

---

## 17. Open Questions and Ambiguities

| # | Ambiguity | Architectural impact | Recommended default |
|---|-----------|----------------------|--------------------|
| 1 | Spec §7 lists auth, persistence and real git/CI integration as out of scope, while §5A/5B (hooks, PR SHAs, write-back, check runs) and the playbook's whole premise require them. | Decides whether the product is a mock or a system. | Treat §7 exclusions as scope of the reference HTML only. Build Phase 1 on real git with local identity; defer auth to Phase 3. |
| 2 | Loop semantics: §1/§7(b) loop the *same* change (CHG-012) back to Plan, while the playbook and §4.6 create a *new* `intent.md`/change from incidents and triage. | Change identity, artifact history layout, metrics (survival rate, repeat incidents). | Support both: gate-6 accept = same id, `cycle+1` with archived artifacts; triage/security accept = new change with `origin` link. Document that gate 6 is for incidents attributable to a deployed change. |
| 3 | Who is the gate-5 "engineer"? The playbook requires a code owner via branch protection and forbids the authoring agent from approving; the spec labels the owner "engineer", who may be the person who steered the session. | Separation of duties; hosted role mapping. | Owner role = `eng`, but the merge is executed through branch protection, which decides whether the steering engineer counts as a code owner. Console shows "merge requires code-owner approval" when the active identity is the session's engineer and not a code owner. |
| 4 | Tech-lead consult for high-risk at gate 2 (playbook Stage 2 step 6) has no console representation; spec routes high-risk only at gate 3. | Whether gate 2 gets a second owner. | Keep one owner per gate; record a `consult.tech_lead` event that the PO must attach when risk=high before gate-2 accept (validation rule, Phase 2). |
| 5 | Where gate-1 acceptance is recorded: playbook says "merge or closing review" of the intent home; spec has an in-console Accept. | Local vs GitHub mode divergence. | Both map to `gate.accepted{1}`; local mode commits directly, GitHub mode merges the intent PR. |
| 6 | Intent home location: playbook suggests `intent/` (or a dedicated repo); spec implies one repo per product with all artifacts. | Directory layout, linked mode. | `sdlc/changes/<id>/` co-locating all six artifacts; `intentHome` config option for a separate repo (linked mode) later. |
| 7 | Session mode vocabulary: spec uses AUTO / PLAN MODE / HEADLESS / SUPERVISED; Claude Code has permission modes (plan, default, auto-accept/bypass) that don't map 1:1. | Launcher flags, eligibility display. | Define console modes as: PLAN = harness plan mode; SUPERVISED = default with prompts; AUTO = auto-accept edits under managed permissions; HEADLESS = `-p`. Adapter maps per harness version. |
| 8 | Spec's Change embeds artifact bodies (`docs`), timestamps as strings, and a shared id counter — a UI seed model, not storage. | Persistence design. | Bodies are files; timestamps ISO in front-matter; ids by scan (§12.2). |
| 9 | What counts as "eval coverage exists for those paths" in eligibility. | Eligibility computability. | An `active` eval case whose `paths[]` glob-matches every file in the plan, OR the verification commands include a test target and the repo's test globs cover the paths (configurable strictness). |
| 10 | Evidence size and screenshots in git. | Repo growth. | Commit final-round outputs and screenshots under a per-file cap (default 1 MB, images ≤ 500 KB re-encoded); larger evidence stored as a check-run/CI artifact with hash + URL in `run-<n>.json`. |
| 11 | Who runs the design pass headlessly and where the org skills live for a PO without a repo checkout. | Job execution location. | Design pass runs in CI on intent merge (playbook Stage 2 step 2); skills come from the repo or the org plugin marketplace pinned in config. |
| 12 | Security findings source is Claude Security (hosted), but spec shows them in-console with status mutations. | Two systems of record. | Scanner is authoritative for the finding; console is authoritative for routing status (`patch`/`escalated`/`dismissed`) and writes the dismissal reason back where the scanner API allows; otherwise the YAML mirror holds it and re-matches by scanner id. |
| 13 | Metrics are "static seed data" in the spec. | Whether metrics are derived. | Derived from real sources with "n/a · needs <source>" states; seed data only in fixtures. |
| 14 | "waiting since" for gates and relative activity timestamps depend on a clock authority. | Consistency across machines. | Commit timestamps are the authority for gate `since`; session events carry harness wall time and are displayed relative to the viewer's clock. |
| 15 | Two-persona role switcher vs many responsibilities (tech lead, platform, policy owner, security, service owner, incident team). | Permission model. | Persona switcher stays as the *view*; additional roles are config-declared and only affect who may perform specific non-gate actions and PR reviews. |

---

## 18. Requirement Traceability

| Design / playbook concept | Product requirement | Technical component | Implementation area (phase) |
|---------------------------|---------------------|---------------------|-----------------------------|
| Six stages, one committed artifact each (PB overview; spec §1) | FR-11, FR-12 | core derivation, artifact store, `sdlc/changes/` layout | Phase 0 (core, git), Phase 1 (UI) |
| Human gates owned by one role; auto-advance for Test (spec §1; PB) | FR-20, FR-21 | gate defs, accept/send-back write-plans, validation (ownership, human actor) | Phase 0/1 |
| Chain of commits is the audit trail (PB) | FR-13, FR-71, §12.5 | `log.jsonl`, commit trailers, `sdlc audit` | Phase 0/1 |
| Loop closed, never terminal (spec §1; PB S6) | FR-14, FR-61 | loop write-plan, cycle archive, triage accept → new change | Phase 1 |
| intent.md capture with template, non-engineer commit via connector (PB S1) | FR-10, FR-01 | templates, `change new`, filesystem interface, later git connector | Phase 0/1 (connector Phase 3) |
| Design pass constrained by skills, concerns flagged, prompt + skill versions logged (PB S2) | §4 Stage 02, §8.3 design-pass | context builder, spec front-matter, headless job | Phase 1 (manual), Phase 2 (CI-triggered) |
| Plan mode → plan.md; interview; commit; check diff against plan (PB S3; spec 5A.1) | FR-30, FR-41 | plan-session job, `submit_plan_revision`, plan-sync hook, `planMatches` | Phase 1 |
| High-risk routing to tech lead via PR (spec 5A.1; PB S2/S3) | FR-20, Q3/Q4 | gate 3 override, code-host adapter | Phase 2 |
| Auto mode as derived eligibility (PB S3 auto mode; spec 5A.1, 5B.1) | FR-34 | eligibility function, sessions card rationale | Phase 1 (basic), Phase 2 (coverage term) |
| CLAUDE.md as working knowledge; repeat-mistake rule; size guard (PB S3; spec 5A.2) | FR-02, FR-43 | parser, proposal engine, Config card | Phase 1 (parse), Phase 2 (proposals) |
| Skills advisory, backed by hooks; owner review; pass % (PB S3; spec 5A.3) | FR-02, FR-42 | skill parser, backed-by lint, trigger-test runner | Phase 1 (list), Phase 2 (pass %) |
| Hooks as deterministic guardrails; ask-hooks belong at gates; managed scope (PB S3/S5; spec 5A.4) | FR-40, FR-42 | hook scripts → `sdlc hook`, settings lint, managed snapshot | Phase 1 |
| Parallel sessions in worktrees; subagents; capacity by review (PB S3; spec 5A.5) | FR-30, FR-31, FR-35 | task split job, launcher, session registry, backlog ceiling | Phase 1 (sessions), Phase 2 (split/ceiling) |
| Source of truth per artifact: repo/external/linked (PB sidebar; spec 5A.6) | FR-16 | records adapter, accept-path validation, header states | Phase 2 |
| Feedback loop: single-command targets, healthy output, quantifiable target, done requires green (PB S4; spec 5B.1–5B.2) | FR-02, FR-32, FR-33, FR-40 | verification contract parser, rounds ingestion, verify-before-done | Phase 1 |
| Fix tasks: failing test first, test freeze, proof at PR (PB S4 step 4/7; spec 5B.3) | FR-51, FR-40 | repro block, test-freeze hook, fallback finding, PR panel | Phase 2 |
| Visual check for UI work (PB S4 step 5; spec 5B.1/5B.2) | FR-33 | visual rounds strip, visualTool detection | Phase 2 |
| Per-change eval run and auto-advance; two reds → human (spec 5B.4) | FR-50 | lifecycle engine, local/CI runner, PR opener | Phase 1 (local), Phase 2 (CI) |
| Continuous evals gating config changes; incident → eval; live suite (PB S4; spec 5B.5) | FR-52, FR-53 | eval files, CI workflows, config gate check, harvest actions, triage signals | Phase 2 |
| Evidence literal, displayed not summarised; logged in transcript and check run (PB S4; spec 5B.6) | P5, FR-50 | evidence storage, check-run publisher, viewer | Phase 1/2 |
| AI in PR review loop; REVIEW.md; findings inform, humans approve (PB S5) | §4 Stage 05, §8.9 | review job, code-host adapter, findings mirror | Phase 2 |
| Hooks as approval gates; production gate; managed settings (PB S5) | §13, FR-40 | production-gate hook template, managed snapshot display | Phase 3 |
| CI/CD: agent up to the production gate, sandboxed, deploy via MCP, rehearsed rollback (PB S5) | §4 Stage 05/06, §13 | deployment MCP tools, `deploy.yaml`, runbook allowlist | Phase 3 |
| Closing the loop: deterministic detection, bands.yaml tiers, triage queue, dismiss tunes bands (PB S6; spec §4.6) | FR-60, FR-61 | bands parser, snapshot cache, diagnose/propose jobs, triage files | Phase 1 (files/UI), Phase 3 (automation) |
| Recurring security scans: validated findings, three routes, dismiss with reason, eval per class (PB S6; spec §4.7) | FR-62, FR-53 | finding mirror, routing actions, escalate → change | Phase 1 (file-backed), Phase 3 (scanner ingest) |
| Claude Tag channel triage (PB S6) | FR-61 | channel → triage adapter | Phase 3 |
| Two personas, role switcher, badges, queues (spec §3, §4.3) | FR-03, FR-21, §10 | config roles, client derivations | Phase 1 |
| Console views and interactions exactly as specified (spec §4, §5, §6) | §10 | UI SPA, snapshot/patch transport, tokens | Phase 1 |
| Metrics per stage, leading/lagging (PB "how to measure"; spec §4.8, 5A.2, 5B.6) | FR-70 | metrics engine + sources | Phase 1 (git/ledger), Phase 2 (PR/CI) |
| No self-approval by agents (PB S5/S6; spec §4.7 footer) | §8.9, §11.1 | MCP surface, validator, branch protection, human-only CLI | Phase 0/1 |
| Reproducible sessions (spec 5B.4 fingerprint; PB governance) | §8.10 | context manifest hash in front-matter, config fingerprint in runs | Phase 1 |
| Model-agnostic harness (PB deployment options; spec fingerprint `model`) | P6, §8.11 | harness contract + adapters | Phase 1 (Claude Code), Phase 3 (others) |

*End of blueprint.*

# SDLC Console — Technical Overview & Implementation Requirements

**Derived from:** *Veri · SDLC Console Design & Implementation Spec v1.0 (2026-09-02)* and *The AI-Native SDLC Playbook (Anthropic, 2026-08-21)*.
**Status:** implementation blueprint for planning and build. No code in this document.
**Reading rule used throughout:** the design spec is the source of *product intent* (what the console shows and what a person can do); the playbook is the source of *workflow and operating-model requirements* (what must be true about the lifecycle, the artifacts, the gates, and the agents). Where the spec's "out of scope" list (auth, persistence, git/CI) conflicts with the playbook's core premise (git is the audit trail), the playbook wins for the product and the spec's exclusions are read as exclusions from the *reference HTML*, not from the product. This is called out explicitly in §17.

---

## 1. System Overview

The SDLC Console is a read-mostly control surface over a git repository that already contains the lifecycle. Every change moves through six stages (Plan, Design, Build, Test, Deploy, Maintain); each stage ends by committing one artifact (`intent.md`, `spec.md`, `plan.md`, eval evidence, a PR with review findings, an incident record) and the next stage begins by reading it. The console's job is to (1) project that repository state into a board, a gate queue, session cards, config views, a loop/triage view, a security view and metrics; (2) let a human make exactly the decisions the playbook reserves for humans (accept/send-back at gates, confirm a repro test, confirm a task split, accept a triage item, route a security finding, accept a CLAUDE.md proposal); and (3) turn each accepted gate into the trigger that fires the next stage's agent work. It does not hold the truth; it renders it and gates it.

**Source of truth.** Files in version control. Lifecycle artifacts live under a `sdlc/changes/<id>/` tree in the product repo; agent configuration (`CLAUDE.md`, `REVIEW.md`, `.claude/skills`, `.claude/agents`, `.claude/settings.json`, hooks) lives where the Claude Code harness already expects it; eval cases and runs live in `evals/`; control bands in `bands.yaml`. Gate decisions are git commits authored by the human who decided (in GitHub mode, the merge of the artifact's pull request). A change's *stage* is never stored — it is derived from which artifacts are accepted and which eval verdict exists for the current head. Everything the console displays that is not in git (session progress, round outputs, telemetry, metric snapshots, external findings) is a rebuildable cache keyed to git SHAs. When the spec's §5A.6 designates an external system (Jira, ServiceNow) as authoritative for an artifact, the repo holds a synced copy plus a link, and the console shows which is which.

**Humans.** Two personas are rendered (product owner, engineer); further responsibilities (tech lead, platform team, policy owner, security lead, service owner, release manager) are *rules* attached to gates and reviewers, not extra console roles. Humans interact through the single-screen console (board → change detail → gate panel), through a CLI that offers the same operations, and — for gates that the playbook says are approved "via PR review" — through the code host's review UI, which the console observes rather than replaces. Non-engineers never touch git directly: the console (or a claude.ai/Cowork connector) commits on their behalf.

**Agents.** AI coding agents are external harnesses (Claude Code in interactive, plan, auto and headless modes; `claude -p` in CI; Agent SDK services; any harness that honours the same contract). The console never runs model inference itself. It supplies agents with three things: a **work discovery** interface (which change is waiting for which artifact), a **context bundle** assembled deterministically from the artifact chain plus repo configuration, and a **reporting** interface (propose an artifact, log a round, log a hook decision, request human input). Agents are structurally unable to accept a gate: the accept operation is only exposed to authenticated human callers, and in GitHub mode it is a merge that branch protection requires a code owner to perform. Hooks that the playbook designates as guarantees (plan-sync, test-freeze, verify-before-done, production gate) are shipped as executable scripts that call the console's core library so their decisions are deterministic and logged.

**Artifact flow.** An accepted `intent.md` (merge on main) fires the design pass, which commits `spec.md` as a PR; an approved `spec.md` opens a plan-mode session that drafts `plan.md`; an accepted `plan.md` splits into worktree sessions; a session that reports done (only possible after a green feedback-loop round) triggers a per-change eval run; a green run opens the PR; the PR merge is gate 5; production monitoring, scheduled security scans and channel triage write findings into a triage queue that, on acceptance, creates a new `intent.md` — the loop closes.

**Architectural boundaries.** (a) *Core domain library* — pure, deterministic, filesystem-in/objects-out: parsing, validation, stage derivation, transition rules, context assembly. (b) *Adapters* — local git, code host (GitHub first), CI check runs, session/hook event ingestion, external record connectors via MCP, metrics sources. (c) *Lifecycle engine* — watches for accepted gates and other triggers, enqueues agent jobs, tracks their outcome. (d) *Interfaces* — human CLI, MCP server for agents, HTTP/WebSocket for the UI, hook entry points. (e) *UI* — the console as specified, holding only `UIState`. Model inference is outside all boundaries.

---

## 2. Core Technical Principles

Each principle is derived from a specific statement in one or both documents.

| # | Principle | Derivation |
|---|-----------|-----------|
| P1 | **Files in git are the source of truth; the console is a projection.** No lifecycle fact may exist only in the console. | Playbook: "the chain of commits is also the audit trail"; "each stage ends by writing one to version control". Spec §5A.6 defines `sourceOfTruth = repo` as a mode and demands the console show "authoritative" vs "copy of". |
| P2 | **Stage is derived, not stored.** A change's stage is a function of accepted artifacts + eval verdict; storing it would create drift the system would then have to police. | Spec §1: "a stage ends at a human gate… or auto-advances"; Stage 4 "auto-advances on green". Playbook: "the commit initiating the next stage". Both define stage by the presence of committed/accepted artifacts. |
| P3 | **A gate decision is an authenticated human git commit.** Accept = commit/merge authored by the gate owner; send back = a recorded review event. Agents have no code path to this operation. | Playbook: "the accept or reject decision… is recorded as the merge or the closing review"; "the agent that wrote the code has no way to approve it". Spec §4.7 footer: "the proposing agent has no route to approve its own fix". |
| P4 | **Deterministic checks are code; judgment is human.** Anything that can be checked mechanically (schema, plan/diff sync, test freeze, green-before-done, eval threshold, link completeness) is enforced by a script or hook; anything requiring judgment (is the spec right, does the repro fail for the right reason, risk classification) is a human action with no auto-pass. | Playbook: "detection stays entirely deterministic, with no model involved"; "a skill is advisory… a hook is the deterministic layer behind it". Spec 5B.2 "Nothing auto-passes"; 5B.4 "Never a bypass button". |
| P5 | **Evidence is literal toolchain output, displayed not summarised.** | Spec 5B.6: "the console displays, never summarises it". Playbook: "the evidence comes from the toolchain". |
| P6 | **Agent orchestration is separated from model inference; the console is harness- and model-agnostic.** The console triggers, contextualises and observes agent work; it does not call a model. | Playbook lists interchangeable harness forms (Claude Code, `claude -p`, claude-code-action, Agent SDK, managed Code Review, Bedrock/Vertex/Foundry routing). Spec 5B.4 records a *config fingerprint incl. model* — i.e. the model is a variable to be recorded, not a fixed dependency. |
| P7 | **Repo configuration steers agents; the console parses, never edits.** `CLAUDE.md`, skills, agents, hooks, `REVIEW.md`, `bands.yaml` are edited through PRs reviewed by their owners. | Spec 5B.1: "Source of truth is CLAUDE.md; the console parses, never edits". Spec 5A.2/5A.3: changes are PRs with code-owner/policy-owner review, "not a console gate". |
| P8 | **Human attention concentrates at gates; nothing else blocks agents.** No approval prompts inside build sessions; approvals belong at PR/production gates. | Playbook: "a hook that asks a human for approval belongs with the gates in Stage 5". Spec 5A.4 flags `ask` hooks in `edit`/`command` phases. |
| P9 | **Autonomy is derived eligibility, never a toggle upward.** AUTO mode is computed from spec, risk, blast radius, coverage and verification presence; a human may only reduce it. | Spec 5A.1 "derived, never a toggle… override AUTO → SUPERVISED, never upward"; 5B.1 adds the fourth term. |
| P10 | **The loop is closed and non-terminal.** Maintain feeds Plan; every incident and every security class becomes an eval. | Spec §1 "loop closed, never terminal"; Playbook Stage 6 and "each production incident gets an eval". |
| P11 | **Local-first, hosted-capable.** The core must run against a local clone with no network (one engineer, one repo); team features layer on a code-host integration and identity. | Playbook Stage 3 infrastructure: "a git repository… worktrees"; spec §7 defers auth/persistence; playbook Stage 1 requires non-engineers to commit via connector — hosted path exists but is additive. |
| P12 | **Extensibility through the harness's own extension points**, not a console plugin system. Skills, subagents, hooks and MCP servers are the extension surface; the console lists them read-only. | Playbook Stage 3 (skills, subagents, hooks, plugin marketplaces) and managed-settings worked example. Spec 5A.5 "Subagents are defined in the repo; Config lists them read-only". |
| P13 | **Immutable, recomputed view state.** All UI derived values (badges, queues, eligibility, stage) recompute from the model on every change; the client never caches a decision. | Spec §5 "All mutations are immutable copies… badges and gate queues recompute from state on every render". |

---

## 3. Functional Requirements

IDs are stable and referenced in §18. "Source" cites spec (§n) or playbook (PB-Stage/play).

### 3.1 Repository, project and configuration

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-01 | Initialise a repo as an SDLC home (`sdlc init`) creating the `sdlc/` tree, `sdlc/config.yaml`, templates, `.gitattributes` merge rules and hook scripts. | The playbook makes stand-up a one-time platform task; the console needs a known layout to parse. | PB-S1 infra; PB-S3 CLAUDE.md | Idempotent; refuses to overwrite existing content; prints what it created. | Monorepo with several products → `sdlc/` may be nested per product; config declares `products[]`. Dedicated intent repo → `intentHome` may point to a second repo (linked mode). |
| FR-02 | Parse repo configuration read-only: `CLAUDE.md` (incl. "Verifying your work" block), `REVIEW.md`, `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.claude/settings.json` + managed settings snapshot, hook scripts, `bands.yaml`, `evals/`. | Config view, eligibility, verification contract, hook validation. | Spec §4.5, 5B.1; PB-S3 all plays | Parser produces typed objects with file path + SHA; parse errors surface as Config-view warnings, never crash. | Missing `CLAUDE.md` → all sessions "no feedback loop"; managed settings unreadable on this machine → show "managed scope unknown". |
| FR-03 | Roles and reviewer rules declared in `sdlc/config.yaml`: identities → roles (`po`, `eng`, `tech_lead`, `platform`, `security`, `service_owner`), skill → policy owner, high-risk rule, thresholds (files-in-plan, review backlog, eval suite size, discriminate-window), `evals.mode`, records mapping per artifact. | Spec renders two personas but 5A/5B name six more responsibilities; gate ownership must be computable. | Spec §1, 5A.1, 5A.3, 5A.5, 5B.5, 5A.6 | Validated against schema on load; invalid config blocks gate actions with a visible reason. | Identity with several roles; no `tech_lead` configured while a high-risk change exists → gate 3 shows "no tech lead configured" instead of silently falling back to engineer. |

### 3.2 Changes and artifacts

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-10 | Create a change (`sdlc change new`, UI via triage/security accept, API) allocating a monotonically increasing `CHG-NNNN` id and writing `sdlc/changes/<id>/change.yaml` + `intent.md`. | Every route into the loop starts with an intent record. | Spec §2, §5; PB-S1 | Id allocated from the highest existing id on the default branch; committed atomically with the intent; `origin` records the entry route. | Two concurrent creators → second commit rebases and re-allocates; validator flags duplicate ids on any branch. |
| FR-11 | Store the six artifacts as files in the change directory (`intent.md`, `spec.md`, `plan.md`, `evals/`, `pr.yaml`, `incident.md`). | Spec's sparse `docs` map; playbook's committed artifact per stage. | Spec §2; PB overview | Absence of file = "not committed yet"; presence on a non-default branch = "pending" (draft/in review); presence on default branch = committed. | Artifact edited after acceptance → marked stale/rework and counted in metrics (PB-S1/S2 lagging). |
| FR-12 | Derive `stage`, `gate`, `gate.since`, `agent`, `status` for every change from artifacts, decision log, sessions and eval runs. | P2. | Spec §2; §1 table | Pure function `deriveChangeView(files, log, sessions, runs) → ChangeView`; unit-tested against the spec's seed scenarios (a)–(n). | Contradictory inputs (plan accepted but spec missing) → change shows a validation error chip and is excluded from gate queues until fixed. |
| FR-13 | Record gate decisions as signed, timestamped entries in `sdlc/changes/<id>/log.jsonl`, and (GitHub mode) as the merge/review of the artifact PR. | P3; audit trail. | Spec §5; PB governance every stage | `accept` and `send_back` events carry actor identity, role, gate index, artifact SHA, optional feedback text. | Send-back feedback must be non-empty; accept blocked when actor's roles don't own the gate. |
| FR-14 | Loop: accepting gate 6 re-enters the same change at stage 1 with `cycle+1`, archiving the previous cycle's artifacts and creating a draft eval case `INC-…`. | Spec §1 "loop closed"; §7(b); 5B.5 harvesting (b). | Spec §1, §5, 5B.5 | Previous artifacts moved to `cycles/<n>/`; `intent.md` for the new cycle seeded from `incident.md`; change cannot pass stage 4 until the INC case is active. | Incident that should be a *new* change rather than a loop → triage path (FR-40) instead; both must exist. |
| FR-15 | Change kind (`feature`/`fix`) and risk (`routine`/`high risk`) set at stage 1/2 by the PO; read-only from Build on. | Routing rules depend on them. | Spec 5A.1, 5B.3 | Stored in `change.yaml`; validator rejects edits to these fields in commits whose change is at stage ≥3. | Incident-loop changes default to `fix`. |
| FR-16 | External record linkage per artifact (`repo` / `external` / `linked`), record-id chip, sync timestamp, write-back on accept via MCP, "write-back failed · retry", linked-mode accept blocked until record id + commit SHA present. | Legacy systems remain systems of record. | Spec 5A.6; PB-S3 sidebar | `change.yaml.record` + per-artifact `records:` in config; write-back is a job with retry; failure never reverts the local accept. | Connector unavailable at accept time → accept succeeds, job queued, amber indicator until success. |

### 3.3 Gates and human decisions

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-20 | Gate definitions: 1 intent (PO), 2 spec (PO), 3 plan (engineer, or tech lead via PR review when high risk), 4 none (auto on green), 5 merge PR (engineer/code owner via branch protection), 6 incident intent (PO). | Spec §1 table; 5A.1 high-risk routing. | Spec §1, 5A.1; PB-S2 step 6, PB-S5 | `gateDefs` is data in core; the high-risk rule swaps owner and disables in-console Accept for gate 3. | Gate 5 Accept in GitHub mode calls the merge API and can fail on branch-protection; failure shown, no local state change. |
| FR-21 | Accept / Merge and Send back actions with the exact state effects in spec §5, enabled only for the active role when that role owns the gate. | Core interaction. | Spec §4.2, §5 | See §4 transitions; toast on success; activity entry prepended. | Role switcher selects a role the identity doesn't hold (hosted mode) → actions disabled with reason. |
| FR-22 | Human-only, non-gate decisions: repro confirmation, task-split confirmation, stalled-loop actions (add guidance / raise cap once / take over), freeze lift once, CLAUDE.md proposal accept/dismiss, triage accept/dismiss, finding routing, AUTO→SUPERVISED override. | Playbook reserves judgment for humans; these aren't stage gates. | Spec 5A.1, 5A.2, 5A.5, 5B.2, 5B.3, §4.6, §4.7 | Each is a logged event with actor; each is engineer- or PO-scoped as the spec states. | Freeze lift is single-use per file per change and logged. |

### 3.4 Sessions, tasks and feedback loop

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-30 | On plan accept, an agent proposes tasks from plan.md's file list; overlapping file sets merge into one sequential task; engineer confirms; one worktree + one session per task, all tagged with the change id. | Parallelism without collisions. | Spec 5A.5; PB-S3 parallel sessions | Proposal stored as `tasks.yaml` (draft) until confirmed; confirmation triggers `git worktree add` per task and session registration. | Plan without a parsable "Files that change" section → proposal empty, engineer must edit plan or define tasks manually. |
| FR-31 | Session registry: worktree, branch, mode (AUTO/PLAN/SUPERVISED/HEADLESS), change id, task, target, file set, status, subagents, loop state, verifier result, test-edit attempts, waiting-on-you flag, auto-accept rationale. | Sessions view and roll-up on change. | Spec §4.4, 5A.5, 5B.2 | Sessions are runtime records fed by hook/OTel events; never committed. | Session process dies → status stale after heartbeat timeout; card shows "unreachable". |
| FR-32 | Target required to start a session; prefilled from plan.md acceptance line; editable inline. | Quantifiable done criterion. | Spec 5B.2; PB-S4 step 3 | Missing target → session card "waiting on you: define done" and session not launched. | Target edited mid-session → logged. |
| FR-33 | Feedback-loop rounds: each round = named command results (pass/fail + excerpt), optional screenshot/diffPct; states not-run/iterating/green/stalled/flaky; stalled and flaky rules per spec. | Sessions verify their own work. | Spec 5B.2; PB-S4 feedback loop | Round events ingested from the harness via hook/MCP; one activity line per round; last round retained in full, earlier rounds' excerpts cached. | Command missing/setup failure → `not-run`, verbatim output shown, no rounds counted. |
| FR-34 | Auto-mode eligibility = spec committed ∧ risk routine ∧ files-in-plan ≤ threshold ∧ eval coverage for those paths ∧ verification block present; derived and displayed as rationale; engineer may downgrade. | P9. | Spec 5A.1, 5B.1 | Recomputed on every relevant change; downgrade logged. | Threshold changed in config → eligibility flips live; running AUTO sessions are not interrupted but card shows the new state. |
| FR-35 | Capacity ceiling: "New session" disabled when review backlog > configured limit. | Review must keep up with output. | Spec 5A.5; PB-S3 step 3 | Backlog = sessions done and awaiting review; computed live. | Limit unset → no ceiling, header shows counts only. |

### 3.5 Hooks, plan sync, test freeze

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-40 | Ship executable hooks `plan-sync` (pre-commit, block), `test-freeze` (pre-edit, block), `verify-before-done` (stop, block), plus a `production-gate` template; each calls the core library and logs its decision to the change log. | Deterministic guarantees behind advisory skills. | Spec 5A.1, 5A.4, 5B.2, 5B.3; PB-S3 hooks, PB-S5 hooks | Exit code 2 with explanatory message; decision event `hook.blocked`/`hook.allowed` with reason. | Repo without managed hooks → fallback Stage 5 auto-finding "diff touches a test file during a fix" that blocks merge until dismissed with reason. |
| FR-41 | `planMatches` computed on every commit: diff files ⊆ plan.md "Files that change" (or plan.md in same commit). Read at stage 5. | Merged diff must match the committed plan. | Spec 5A.1; PB-S3 step 7 | Stored as an event with commit SHA; PR panel shows it. | Plan edited in same commit → allowed and logged as plan revision. |
| FR-42 | Hook validation in Config: `ask` in `edit`/`command` phases flagged "approval prompt in build — move to PR gate". | P8. | Spec 5A.4 | Static check over parsed settings. | Managed hooks cannot be flagged as switchable. |
| FR-43 | Repeat-mistake signal: two send-backs or hook blocks across sessions citing the same reason → agent job proposes a `CLAUDE.md` line; Accept opens a PR; Dismiss logged. | Institutional knowledge loop. | Spec 5A.2; PB-S3 CLAUDE.md step 4; PB-S5 step 5 | Reason strings normalised (lowercase, trimmed) and grouped per repo; proposal stored as `sdlc/proposals/<id>.yaml` until resolved. | Same reason a third time while a proposal is pending → count increments, no duplicate proposal. |

### 3.6 Test stage: per-change runs and eval suite

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-50 | Per-change eval run on session completion: eval cases whose paths intersect the file set + full verification commands, non-interactive; green → PR opened, stage 5; red → stays 4, session re-enters with failing output; two reds → waiting on you. | Auto-advance without a human. | Spec 5B.4 | Run record written to `sdlc/changes/<id>/evals/run-<n>.json` with config fingerprint; PR opened via code host adapter. | No eval cases intersect → run consists of verification commands only; still valid. |
| FR-51 | Repro-first for fix changes: repro card, confirm commits the test alone (SHA recorded), freeze active until merge; PR panel shows repro proof. | Proof the bug is gone. | Spec 5B.3; PB-S4 step 4 | `repro` block in `change.yaml`; confirmation is a logged engineer event + commit. | Agent proposes test change → surfaced as a proposal card; engineer edits manually or lifts freeze once. |
| FR-52 | Eval suite: cases (`evals/cases/*.json`), runs (`evals/runs/*.json`), config-change gate as a required check on PRs touching `CLAUDE.md`, `.claude/**`, model pin; regressed cases with before/after output; scheduled vs continuous mode; budget stop → "incomplete". | Configuration regression-tested like code. | Spec 5B.5; PB-S4 continuous evals | Console reads and displays; CI executes; manual "Run suite" enqueues a real run through the CI adapter. | Suite < 20 cases → "under-sized"; a case passing 100% over N runs → triage item; failing every run for 3 runs with no config change → "broken check". |
| FR-53 | Harvest cases: "Add as eval" after merge (draft, platform owner); incident loop creates `INC-…` draft (incident team owner). | Live suite. | Spec 5B.5 (a)(b); PB-S4 step 5 | Draft cases excluded from pass rate; the incident's change blocked at stage 4 until the case is active. | Case activated without checks → validator rejects. |

### 3.7 Loop, triage, security

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-60 | Control-band table from `bands.yaml` + metric snapshots; breached rows amber; footer states tiers. | Deterministic detection surfaced. | Spec §4.6; PB-S6 closing the loop | Detection runs outside the console (script/CI) and writes snapshots + triage items; console renders. | Metric source unreachable → row shows "no data · since T". |
| FR-61 | Triage queue: items from band breaches, flaky checks, non-discriminating evals, skill-not-triggering, channel/ticket triage; Accept → Plan creates a change with pre-drafted intent and an open gate 1; Dismiss records a reason and optional band-tune note. | Loop feeds itself. | Spec §4.6, 5A.3, 5B.2, 5B.5; PB-S6 | Items are files `sdlc/loop/triage/TRI-NNNN.md` with frontmatter; accept moves the file to the change's `origin` and deletes it from the queue in the same commit. | Item accepted twice concurrently → second fails on missing file. |
| FR-62 | Security findings: ingest from scanner (Claude Security webhook/export or CSV/Markdown import); three actions with the exact status effects in spec §4.7; dismissals with reason persisted so the finding doesn't return as new. | Findings go through the same gates. | Spec §4.7; PB-S6 recurring scans | Findings mirrored under `sdlc/security/findings/SEC-NNNN.yaml` (status + reason committed; scanner payload cached). | Scanner re-reports a dismissed finding → matched by scanner id, stays dismissed. |

### 3.8 Metrics and observability

| ID | Requirement | Why | Source | Expected behaviour | Edge cases |
|----|-------------|-----|--------|--------------------|-----------|
| FR-70 | Compute per-stage leading/lagging metrics over a 30-day window from git history, decision log, PR metadata, CI, session telemetry and incident/triage records; render trend chips. | Playbook's "how to measure it" per play. | Spec §4.8, 5A.2, 5B.6; PB every play | Metric definitions are code with source declarations; snapshot cached, recomputed on schedule and on demand. | Source missing (no CI adapter) → metric shows "n/a · needs CI" rather than zero. |
| FR-71 | Every agent and system event that affects a change is visible in the change activity feed with actor glyph and relative time; hook decisions and eval rounds included. | Auditability. | Spec §4.2, 5A.4, 5B.2 | Feed = union of committed `log.jsonl` events (all branches) + cached session events, sorted by timestamp, de-duplicated by event id. | Clock skew across machines → events carry both wall time and monotonic sequence within a session. |

---

## 4. Lifecycle / Pipeline Architecture

Conventions used below. **Human** = a named person acting through console, CLI or code-host UI. **Agent** = an external harness session. **System** = deterministic code in the console/core/hooks/CI. Artifact paths are relative to `sdlc/changes/<id>/`.

### Stage 01 · Plan → `intent.md` · gate 1 (product owner)

| | |
|---|---|
| **Inputs** | An entry event: a person's idea (free text / conversation), a ticket (via connector), a triage item (`TRI-…`, pre-drafted intent), a security escalation (`SEC-…`), an incident record from a looping change (`cycles/<n>/incident.md`), or a channel message (Claude Tag). The org's `intent.md` template/skill. |
| **Actions** | *Human (originator):* brainstorms with an agent, corrects the draft, commits (via console/connector). *Agent:* asks analyst questions, writes `intent.md` in template form; for triage/security/incident origins the intent is generated headlessly. *System:* allocates id, creates `change.yaml` (`kind`, `risk` defaults, `origin`), validates template sections, commits, opens gate 1, computes "since". |
| **Outputs** | `change.yaml`, `intent.md` (committed on default branch in local mode; as a PR in GitHub mode), `log.jsonl` entry `artifact.committed{artifact:0}`. |
| **Validation** | Template sections present (Problem, Proposed outcome, Affected users and systems, Constraints, Open questions); author + timestamp in front-matter; id unique; `record` present if artifact 0 is `external`/`linked`. |
| **Human gate** | PO accepts (→ Design) or sends back with feedback. Risk classification and `kind` are set here or in Design by the PO. |
| **Agent interface** | Reads: template skill, origin payload. May: write `intent.md` draft, ask clarifying questions. May not: accept, edit `change.yaml.risk/kind`. |
| **Transition** | Accept → `gate.accepted{gate:1}` commit. Lifecycle engine observes it (file watcher on default branch / merge webhook) and enqueues the *design pass* job with context = `intent.md` + org skills. |

### Stage 02 · Design → `spec.md` · gate 2 (product owner)

| | |
|---|---|
| **Inputs** | Accepted `intent.md`, org skills (brand, security, compliance, UX), optional design mock (Claude Design export / attached image) stored under `design/`. |
| **Actions** | *Agent (headless first, then PO-driven iteration):* produces `spec.md` with flagged concerns; records the prompt used and skill versions in front-matter. *Human (PO):* reviews spec against intent, resolves flagged concerns with policy owners (recorded as spec revisions), consults tech lead for high-risk, sets `risk`. *System:* opens spec as PR (GitHub mode) or draft branch; validates; links concern items to policy owners from config. |
| **Outputs** | `spec.md` (front-matter: `intent_sha`, `prompt_ref`, `skills: [{name, version}]`, `concerns: [{id, policy, owner, resolved}]`), optional `design/*`. |
| **Validation** | `intent_sha` matches accepted intent; every concern either resolved or explicitly carried forward; open questions from intent answered or carried; risk set. |
| **Human gate** | PO approves spec; high-risk requires a recorded tech-lead consult (an event, not a second gate — spec §1 keeps one owner per gate). |
| **Agent interface** | Reads intent, skills, mock. Writes spec draft. May flag concerns. May not resolve concerns or approve. |
| **Transition** | `gate.accepted{gate:2}` → engine enqueues *plan mode session* creation for an engineer (assignment from config or first claim), context = intent + spec + `CLAUDE.md`. |

### Stage 03 · Build → `plan.md` · gate 3 (engineer; tech lead via PR review when high risk)

| | |
|---|---|
| **Inputs** | Accepted intent + spec, `CLAUDE.md`, skills, subagent definitions, codebase (read-only in plan mode), thresholds. |
| **Actions** | *Agent (plan mode):* reads codebase, drafts `plan.md` (Files that change, Order of work, Risks, Proof), increments `planRev` on each rewrite, marks a draft "final". *Human (engineer):* interrogates the plan (what could break, riskiest step, alternatives); questions logged; accepts or sends back. *High-risk:* engineer may only send back; acceptance arrives as a code-owner merge of the plan PR. *System:* tracks `planRev`, `planState`; computes `autoEligible`; on accept freezes rev, records accepted-by; agent proposes task split; on engineer confirm creates worktrees + sessions; runs `plan-sync` hook on every commit; computes `planMatches`. *After accept, implementation:* agent sessions in AUTO/SUPERVISED per eligibility; feedback loop runs (Stage 4 play inside Build); for `fix` changes the repro sub-phase runs first. |
| **Outputs** | `plan.md` (front-matter: `spec_sha`, `rev`, `accepted_by`, `accepted_at`, `files[]`, `acceptance_line`), `tasks.yaml` (confirmed split), worktrees/branches, `repro` block in `change.yaml` (fix), `log.jsonl` events (`plan.drafted`, `question`, `plan.final`, `gate.accepted`, `tasks.proposed/confirmed`, `hook.*`, `round`). |
| **Validation** | `plan.md` parses (files list machine-readable); `spec_sha` current; on accept: `planState=committed`; eligibility inputs computable; every task has a target before its session starts; commits touching files outside `files[]` blocked unless plan.md in same commit. |
| **Human gate** | Gate 3: accept plan (engineer) or via PR (tech lead, high risk). Non-gate human decisions: task-split confirm, repro confirm, AUTO→SUPERVISED, stalled-loop actions, freeze lift once. |
| **Agent interface** | Plan session: read repo, write only `plan.md` draft (harness plan mode enforces). Build sessions: edit within worktree, run verification commands, propose (not apply) test changes during fix, report rounds, report done (blocked unless green). Never: accept gate, edit tests under freeze, edit `change.yaml.risk/kind`, commit outside plan without updating plan. |
| **Transition** | Session reports done → `verify-before-done` allows only if last round green → engine enqueues the *per-change eval run* (Stage 4) for that worktree. |

### Stage 04 · Test → `evals/` · no human gate (auto-advance on green)

| | |
|---|---|
| **Inputs** | Completed worktree, its file set, final green loop round (output + screenshots), eval cases whose paths intersect the file set, verification commands from `CLAUDE.md`, repro proof (fix), config fingerprint (`CLAUDE.md` SHA, skill versions, hooks SHA, model). |
| **Actions** | *System:* runs cases + commands non-interactively (CI runner or local runner), writes `evals/run-<n>.json`, sets change status "Evals running · N cases"; green → writes evals artifact body, opens PR with check run attached, advances; red → status "Evals red — agent fixing", re-enters session with failing output as target; second red → "waiting on you". *Agent:* fixes code on red. *Human:* only intervenes when waiting-on-you; may add guidance or send back to Plan. No bypass. |
| **Outputs** | `evals/run-<n>.json`, `evals/final-round.json` (+ screenshots), `evals/repro.json` (fix), PR (`pr.yaml` with number/url/head SHA), check run on the PR carrying the evidence. |
| **Validation** | All commands exit 0 with healthy output; all intersecting cases pass; for fix changes repro test unchanged and now passing; for incident-loop changes the `INC-…` case is `active`. |
| **Human gate** | None. (Waiting-on-you is an escalation, not a gate; the change remains at 04.) |
| **Agent interface** | Receives failing case output as next target; same permissions as Build session. |
| **Transition** | Green run → `evals.green` event + PR opened → stage 5 with gate 5 open, `since` = PR opened time. |

### Stage 05 · Deploy → PR + findings · gate 5 (engineer / code owner via branch protection)

| | |
|---|---|
| **Inputs** | PR, `REVIEW.md`, `spec.md`, `plan.md`, `planMatches`, repro proof, evidence check run, security findings with status "patch in PR gate" targeting this PR. |
| **Actions** | *Agent (review harness — managed Code Review or claude-code-action):* runs review passes (bugs, security, compliance vs spec/plan), posts findings ranked by severity, publishes machine-readable tally; on `@claude` addresses comments and pushes fixes; "babysit to green" loop. *Human (code owner):* reads intent and risk, approves via branch protection, merges (console Merge calls the merge API). *System:* mirrors PR state, findings, checks into `pr.yaml`/cache; blocks Merge when required checks fail, when test-freeze fallback finding is undismissed, or when linked-mode record data is missing; on merge triggers pipeline; per-environment deploy via MCP tools behind hooks; production requires release authorization (hook). |
| **Outputs** | `pr.yaml` (number, url, head SHA, merge SHA, reviewers, findings summary, check verdicts, merged_at), review findings (mirrored), deployment record `deploy.yaml` (env, version, time, authorized_by), `gate.accepted{gate:5}` event. |
| **Validation** | Required checks green; code-owner approval present; `planMatches=true` or explicitly acknowledged in review; fix-change repro proof green; no undismissed blocking auto-findings. |
| **Human gate** | Merge (code owner). Release authorization to production (release manager, via hook — recorded as `deploy.authorized`). |
| **Agent interface** | Review harness reads diff + artifacts; may post findings, push fixes to the PR branch, prepare a release; may not approve, merge, push to main, or deploy to production. |
| **Transition** | Merge webhook / local detection → stage 6; post-merge "Add as eval" action available; change status "Deployed · monitoring". |

### Stage 06 · Maintain → incident record · gate 6 (product owner) → loops to 01

| | |
|---|---|
| **Inputs** | Metric snapshots vs `bands.yaml`, scheduled scan results, channel/ticket triggers, deploy records, lessons file. |
| **Actions** | *System (deterministic detection script):* computes bands, logs 1σ, invokes agent read-only at 2σ, allows propose at 3σ (PR into review gate or pre-approved runbook e.g. rollback). *Agent (headless):* diagnoses, writes finding/intent draft into triage queue, or opens PR, or triggers runbook; scanner validates findings with confidence. *Human (service owner / on-call / PO):* triages queue; for an incident tied to a deployed change, records `incident.md` and accepts gate 6 to loop. *System:* on gate 6 accept increments cycle, archives, seeds new intent, creates draft `INC` eval case. |
| **Outputs** | `incident.md` on the change (anomaly, evidence, proposed outcome, affected systems, open questions), `TRI-…` triage items, `SEC-…` findings, eval case drafts, runbook invocation records, lessons file entries. |
| **Validation** | Incident record in intent-compatible format; tier action allowed by `bands.yaml`; runbook in pre-approved list; every dismissal has a reason. |
| **Human gate** | Gate 6: PO accepts incident intent (loop) — or triage accept creates a new change instead. |
| **Agent interface** | Tier-scoped tools from `bands.yaml` (`Read,Grep,Bash(gh run view *)` at 2σ; PR/runbook routes at 3σ); no production credentials; writes only to triage queue, PR branches, or approved runbook triggers. |
| **Transition** | Loop: gate 6 accept → stage 1 of cycle n+1. New work: triage accept → new change at stage 1. Eval hardening: fix merged → INC case must be activated. |

### 4.1 Between-stage mechanics (what the engine must do at every boundary)

1. **Detect** the accepting commit/merge (watcher on default branch + code-host webhook + `sdlc accept` direct call).
2. **Re-derive** the change view; if derivation fails validation, halt and surface — never enqueue work from an inconsistent state.
3. **Record** the transition event (`stage.entered{n}`) in `log.jsonl` (system actor) so history is explicit even though stage is derived.
4. **Assemble** the next stage's context bundle (§8.3) and write its manifest to the job record.
5. **Enqueue** the agent job with an idempotency key (`<change>:<cycle>:<stage>:<artifact sha>`) so a replayed webhook cannot double-launch.
6. **Reset** UI-facing derived state (artifact selection default, status text) by virtue of recomputation; nothing is reset imperatively.
7. **Write back** to external records where configured, as a retryable job.

---

## 5. Domain Model

Persistence legend: **G** = committed to git (source of truth), **C** = rebuildable cache (local state dir), **E** = ephemeral (in-memory / client), **X** = external system of record, mirrored.

### 5.1 Repository / Product
- **Purpose:** the root the console operates on; owns configuration and the change tree.
- **Fields:** `path`, `defaultBranch`, `products[]` (monorepo), `config` (parsed `sdlc/config.yaml`), `verification` (parsed from `CLAUDE.md`), `hooks[]`, `skills[]`, `subagents[]`, `reviewPolicy` (`REVIEW.md`), `bands[]`, `evalsMode`, `managedSettingsSnapshot`.
- **Relationships:** has many Changes, TriageItems, Findings, EvalCases, EvalRuns, Sessions.
- **Lifecycle:** initialised once; config evolves via PR.
- **Ownership:** platform team (managed parts), engineers (team parts).
- **Validation:** config schema; every referenced identity resolvable; thresholds numeric; `records` mode per artifact ∈ {repo, external, linked}.
- **Persistence:** G (config files), C (parsed snapshot keyed by tree SHA).

### 5.2 Change
- **Purpose:** one unit of work moving around the loop.
- **Fields (stored, `change.yaml`):** `id`, `title`, `kind`, `risk`, `created{by,at}`, `origin{type,ref}`, `record{system,id,url}|null`, `cycle`, `repro{state,testPath,failureReason,sha}|null`, `closed{at,reason}|null`.
- **Fields (derived, `ChangeView`):** `stage`, `gate{s,since,owner}`, `agent`, `status`, `docs{0..5: {state, sha, path, authoritative|copy, syncedAt}}`, `planRev`, `planState`, `planMatches`, `autoEligible{value, terms[]}`, `activity[]`, `sessions[]`, `tasks[]`, `latestRun`, `pr`, `validationErrors[]`.
- **Relationships:** has one artifact per index per cycle; has many Decisions, Tasks, Sessions, EvalRuns (per-change), one PR per cycle; origin may reference TriageItem / Finding / prior cycle.
- **Lifecycle:** stage 1→6→1 (cycle+1) or closed (intent rejected, dismissed).
- **Ownership:** PO owns 1/2/6 decisions and `risk/kind`; engineer owns 3/5 and build decisions.
- **Validation:** id format `CHG-\d{4}`; `risk/kind` immutable at stage ≥3; artifacts' front-matter SHAs chain (spec→intent, plan→spec); `record` required per `records` config.
- **Persistence:** G (`change.yaml`, artifacts, `log.jsonl`, `tasks.yaml`), C (derived view).

### 5.3 Artifact
- **Purpose:** the durable output of a stage.
- **Fields:** `index 0..5`, `name`, `path`, `body`, `frontMatter` (schema per index), `state ∈ {absent, draft, pending-review, committed, stale}`, `sha`, `committedAt`, `committedBy`, `rev` (plan), `sourceOfTruth`, `externalRef`.
- **Relationships:** belongs to Change+cycle; index 3 (evals) is a directory of run/round/repro files; index 4 (PR) is `pr.yaml` + mirrored findings; index 5 is `incident.md`.
- **Lifecycle:** absent → draft (branch/worktree) → pending-review (gate open) → committed (accepted on default branch) → stale (later edits after acceptance; counted as rework).
- **Ownership:** produced by agent; accepted by gate owner.
- **Validation:** per-index schema (§11.1).
- **Persistence:** G.

### 5.4 Gate Definition (static data)
- `s ∈ {1,2,3,5,6}`, `label`, `ownerRole`, `acceptLabel` ("Accept"/"Merge"), `onAccept: nextStage`, `highRiskOverride` (gate 3 → `tech_lead`, mode `via_pr`), `externalMode` (gate 5 → `via_branch_protection`).

### 5.5 Decision / Event (`log.jsonl` entry)
- **Purpose:** append-only ledger of everything that happened to a change; source of the activity feed and of stage derivation.
- **Fields:** `id` (ULID), `ts`, `seq`, `actor{type: human|agent|system, id, role?, session?}`, `event` (enumerated: `artifact.committed`, `gate.accepted`, `gate.sent_back`, `stage.entered`, `plan.drafted`, `question`, `tasks.proposed`, `tasks.confirmed`, `session.started/stopped`, `round`, `hook.blocked`, `hook.allowed`, `verifier.result`, `repro.failed/confirmed`, `freeze.lifted`, `evals.green/red`, `pr.opened/merged`, `review.finding`, `deploy.*`, `record.writeback.*`, `override.mode`, `note`), `data` (event-specific), `sha` (commit context), `cycle`.
- **Validation:** JSON schema per event type; human events require an identity; agent events require a session id.
- **Persistence:** G, with `merge=union` so branches don't conflict; high-frequency telemetry is *not* in this file (see Session).

### 5.6 Task
- **Purpose:** one slice of an accepted plan that maps to one worktree/session.
- **Fields:** `id`, `changeId`, `title`, `files[]`, `sequential` (merged overlaps), `target` (done criterion), `worktree`, `branch`, `state ∈ {proposed, confirmed, running, done, reviewed}`.
- **Validation:** file sets of sibling non-sequential tasks disjoint; target non-empty before `running`.
- **Persistence:** G (`tasks.yaml`).

### 5.7 Session
- **Purpose:** one live harness process working a task.
- **Fields:** `id`, `worktree`, `branch`, `changeId`, `taskId`, `mode ∈ {AUTO, PLAN, SUPERVISED, HEADLESS}`, `engineer`, `startedAt`, `heartbeatAt`, `status`, `target`, `files[]`, `subagents[{name,state}]`, `loop{state, rounds[]}`, `verifier{ran, saw, mismatch}`, `testEditAttempts`, `waitingOnYou{reason}`, `autoRationale{terms}`, `modelPin`, `contextManifestRef`, `transcriptRef` (OTel/JSONL location).
- **Relationships:** belongs to Change/Task; emits Events.
- **Lifecycle:** registered → running → (waiting) → done → reviewed → archived.
- **Validation:** target required; mode ≤ eligibility.
- **Persistence:** C (registry + telemetry); summary lines mirrored into `log.jsonl` (start/stop/round/hook).

### 5.8 Round
- `n`, `ts`, `results[{name, pass, exitCode, outputExcerpt}]`, `screenshotRef?`, `diffPct?`, `filesChangedSinceLast` (for flaky detection), `flaky[]`.
- Persistence: C for intermediate rounds; final green round G under `evals/final-round.json` (+ screenshots).

### 5.9 Verification Contract
- Parsed from `CLAUDE.md` "Verifying your work": `commands[{name, cmd, healthyOutput?, singleTarget}]`, `testGlobs[]`, `visualTool`, `maxLoopRounds` (default 5).
- Persistence: G (source) / C (parsed). Console never writes it.

### 5.10 EvalCase / EvalRun / PerChangeRun
- **EvalCase (`evals/cases/<id>.json`):** `id`, `prompt`, `checks[]`, `source{type, ref}`, `owner`, `added`, `status ∈ {draft, active, retired}`, `paths[]` (for intersection), `passHistory` derived from runs.
- **EvalRun (`evals/runs/<id>.json`):** `id`, `trigger ∈ {schedule, config-pr, manual}`, `configRef{claudeMdSha, skills[{name,version}], hooksSha, model}`, `results[{caseId, pass, output}]`, `passRate`, `threshold`, `verdict ∈ {pass, fail, incomplete}`, `cost`, `startedAt`, `finishedAt`.
- **PerChangeRun (`sdlc/changes/<id>/evals/run-<n>.json`):** same shape plus `worktree`, `fileSet`, `commandResults[]`, `verdict ∈ {green, red}`.
- Validation: active case must have ≥1 check; incomplete never counts as pass.
- Persistence: G (cases, run summaries); large outputs may be G under a size cap or C with a content hash recorded in G.

### 5.11 TriageItem (`sdlc/loop/triage/TRI-NNNN.md`)
- Front-matter: `id`, `tier ∈ {1σ,2σ,3σ,incident,flaky,eval-retire,skill-trigger,channel}`, `src` (metric/session/scan/channel ref), `title`, `evidence`, `createdAt`, `status ∈ {open, accepted, dismissed}`, `dismissal{by, reason, bandTune?}`; body = pre-drafted intent.
- Persistence: G. Accept → moves body into new change's `intent.md`; file marked accepted (or removed; recommend removal with the change's `origin` recording the id, keeping history in git).

### 5.12 ControlBand + MetricSnapshot
- **ControlBand (`bands.yaml`):** `metric`, `baseline`, `rules`, `tiers{1sigma{action}, 2sigma{action, tools}, 3sigma{action, routes[]}}`.
- **MetricSnapshot:** `metric`, `ts`, `baseline`, `current`, `sigma`, `tier`, `breached`.
- Persistence: G (bands), C (snapshots written by the detection script; last N retained).

### 5.13 SecurityFinding
- Stored: `sdlc/security/findings/SEC-NNNN.yaml` → `id`, `scannerId`, `sev`, `conf`, `repo`, `title`, `desc`, `status`, `dismissal{by, reason}`, `escalatedTo (CHG)`, `patchPr`. Scanner payload cached (C); scan metadata (cadence, repo count, last run) C.
- Validation: dismiss requires reason; escalate creates change atomically.

### 5.14 Hook / Skill / Subagent / Proposal
- **Hook:** `name`, `phase ∈ {edit, command, commit, stop, pre-deploy}`, `action ∈ {block, ask, allow}`, `scope ∈ {managed, team}`, `matcher`, `script`, `description`, `warnings[]`.
- **Skill:** `name`, `trigger` (description), `owner`, `version` (from git), `passPct` (from trigger-test set), `backedBy` (hook name | advisory), `mustHold`, `pendingPr?`, `findingsCiting` (count).
- **Subagent:** `name`, `description`, `tools[]`, `path`.
- **Proposal (`sdlc/proposals/<id>.yaml`):** `type ∈ {claude-md-line, test-change}`, `text`, `citations[]` (change ids / reasons), `status ∈ {open, accepted, dismissed}`, `pr?`.
- Persistence: G.

### 5.15 Identity / Role assignment
- `id` (git email / code-host handle), `roles[]`, `skillsOwned[]`; from `sdlc/config.yaml`. In hosted mode the authenticated principal must map to one identity.

### 5.16 ContextManifest / AgentJob
- **AgentJob:** `id`, `idempotencyKey`, `changeId`, `cycle`, `stage`, `kind ∈ {design-pass, plan-session, split-proposal, build-session, eval-run, review, claude-md-proposal, diagnose, propose}`, `state ∈ {queued, running, done, failed}`, `harness`, `manifestRef`, `result{artifactSha?, eventsRange}`.
- **ContextManifest:** list of `{path, sha}` included, skill versions, `CLAUDE.md` sha, hooks sha, model pin, prompt template ref, allowed tools. Persistence: C, with its hash recorded in the resulting artifact's front-matter (G) for reproducibility.

### 5.17 UIState (client only, E)
Exactly as spec §2 plus `identity`, `connection`, `filters` (evals table), `expanded` panels.

---

## 6. State and Artifact Model

| Category | Contents | Reasoning |
|----------|----------|-----------|
| **Persisted & committed (G)** | `change.yaml`, the six artifacts, `log.jsonl`, `tasks.yaml`, per-change eval evidence (final round, run summaries, repro proof, screenshots under a size cap), `pr.yaml`, `deploy.yaml`, `incident.md`, `cycles/<n>/*`, triage items, finding status files, proposals, eval cases, eval run summaries, `sdlc/config.yaml`, `CLAUDE.md`, `REVIEW.md`, `.claude/**`, `bands.yaml`. | These *are* the audit trail (P1, P3). Anything an auditor might ask "who asked, what was produced, who approved" must be here. |
| **Generated dynamically (never stored)** | Stage, gate open/owner/since, agent flag, status text, badges, gate queues, auto-eligibility, `planMatches` view, skill pass %, backlog counts, "waiting" durations, stepper node states, artifact authoritative/copy header, metric trend chips. | P2/P13. Derivation is cheap relative to repo size; storing invites drift. |
| **Cached (C, rebuildable)** | Parsed config snapshot, derived `ChangeView` per head SHA, session registry & telemetry, intermediate rounds, scanner payloads, metric snapshots, external record sync state, job queue state, search index, PR/check mirror. | Needed for latency and for data that is high-volume or external, but must be reconstructible from git + external APIs. Deleting the cache directory must never lose a lifecycle fact. |
| **Derived from other artifacts** | `passHistory` per case (from runs), `findingsCiting` per skill (from PR findings), repeat-mistake counts (from `hook.blocked` + `gate.sent_back` reasons), rework counts (artifact commits dated after the next artifact's first commit), incident→active-case time. | Metrics are functions over the ledger; declaring them derived keeps one truth. |
| **Ephemeral (E)** | `UIState`, toast + timer, WebSocket subscriptions, in-flight optimistic UI, form drafts (target edits before save). | Spec §2 UIState; nothing here has audit value. |
| **External system of record (X)** | Jira/ServiceNow/requirements records when `records.<artifact> = external`; code-host PR state, review findings and check runs; CI run logs; OTel traces; scanner results. | Playbook sidebar; the console mirrors with links and shows sync state rather than duplicating authority. |

**Why no database:** every persisted fact is either a lifecycle fact (must be git for auditability) or a cache. A single-file embedded store (SQLite) is acceptable *as the cache implementation* because it is disposable; it must not become a second source of truth. Hosted/team mode later may add a service-side cache and job queue, still rebuildable from git + webhooks (§17).

---

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

## 10. UI Technical Requirements

Global: one SPA, `UIState` as in spec §2, view enum drives rendering (no router). The client receives a full derived snapshot on connect and patches thereafter; every badge/queue/panel is recomputed client-side from the snapshot (P13). Global loading state = "connecting to `sdlc serve`"; global error = adapter/validation banner (red only for blocking config errors, amber otherwise). Visual tokens per spec §6 are implemented as CSS variables; only `kilnpulse` animates.

| View | Data required | User actions | System actions | State transitions | Loading / error / empty | Artifact relationship |
|------|---------------|--------------|----------------|-------------------|-------------------------|-----------------------|
| **Top bar** | identity, roles held, active role, badge counts (own open gates, triage length, findings `new`) | switch tab (clears `sel`), switch role (re-filters only) | compute badges; hide at 0; keep Pipeline highlighted in detail | `view`, `role` | roles unavailable → switcher disabled with tooltip | — |
| **Pipeline** | `ChangeView[]` (id, title, stage, agent, status, gate, risk) | click card → detail | derive column counts | `sel`, `view=detail` | empty column "Nothing here"; snapshot pending → skeleton columns | column = stage; caption = artifact name |
| **Change detail** | full `ChangeView`, artifact bodies (lazy per index), activity, sessions roll-up, tasks proposal, repro block, PR mirror, record link, validation errors | back; select stepper node; Accept/Merge; Send back (feedback required); confirm/edit tasks; repro confirm/reject; evals strip round click; AUTO→SUPERVISED; "Add as eval"; retry write-back; open record/PR links | default node = current stage's artifact (draft state for plan); reset selection on stage change; render gate/no-gate panel per ownership and high-risk rule; show write-back status; show linked-mode block message | accept → stage+1 (or loop), gate cleared, agent=true, status text, toast; send-back → same stage; repro confirm → freeze active | artifact absent: "Not committed yet — …"; body loading: mono skeleton; merge refused by branch protection: inline error with PR link; validation errors: chip + list | one node per artifact index; viewer header shows committed/pending/draft rev/authoritative/copy · synced |
| **Gates queue** | changes with open gate, ownership by active role, `since` | click row → detail | split YOURS/OTHER; sort by since desc | `sel` | own queue empty: "Queue clear — nothing waiting on the <role>" | gate ↔ artifact under review |
| **Sessions** | session registry, tasks, change ids, backlog count, eligibility rationale, verifier, loop state, waiting-on-you, test-edit attempts, verification block presence, visual-tool warning | open change; New session (target required); add guidance; raise cap once; take over; downgrade mode | compute "N active · review backlog M"; disable New session over ceiling with reason | session states per §5.7 | no sessions: empty grid + footer callout; harness unreachable: card "unreachable"; verification missing: "no feedback loop — set up verification" | sessions roll up to a Change; rounds → evals artifact |
| **Config** | parsed `CLAUDE.md` (version, word count, freshness, working rule, verification block present/missing, command rows), subagents, skills table (+backed-by, pass %, pending review), hooks table (+warnings, scope), proposals, records mapping, evals section (suite size, pass %, threshold, history strip, budget, mode, case table w/ filters) | Run suite; Accept/Dismiss proposal; filter cases; open file/PR links | parse read-only; lint hooks; flag advisory must-hold skills; size guard amber; scheduled-mode amber banner | proposal → PR pending chip | parse error per card (amber) with path; managed settings unknown | config fingerprint ↔ eval runs |
| **Loop** | bands + snapshots, triage items | Accept → Plan; Dismiss · tune band (reason) | amber breached rows; on accept create change + toast + badge decrement | item removed; new CHG at stage 1 | no data per metric; queue empty: "Queue clear — the loop is feeding itself." | triage body → `intent.md` |
| **Security** | findings + scan metadata | Patch → PR gate; Wider → intent.md; Dismiss with reason | status updates; create change on escalate; dismissed → 50% opacity, actions hidden | per §4.7 | scanner not connected: subhead shows import option | escalation → new `intent.md`; patch → existing PR gate |
| **Metrics** | per-stage metric values, trend, notes, window | none (read-only) | compute/trend; "n/a · needs <source>" | — | source missing states | metrics derived from artifacts/ledger |

**Synchronisation rule:** the client never applies a mutation locally except to `UIState` and the toast. Every action posts to the server, which commits (or attempts the external call), recomputes, and pushes the new snapshot; the toast is emitted by the server response so text matches the actual outcome ("write-back failed · retry" vs success). Optimistic UI is limited to disabling the clicked button until the response arrives.

---

## 11. Validation and Governance

### 11.1 Enforced mechanically (validation engine, hooks, CI)

| Rule | Where | Blocking? |
|------|-------|-----------|
| Schema validity of every `sdlc/` file and every `log.jsonl` event | pre-commit (`sdlc validate --staged`), CI on PR, watcher | yes |
| Artifact completeness (required sections per template) before a gate can open | propose_artifact, validate | yes for gate open |
| SHA chaining: `spec.intent_sha` = accepted intent; `plan.spec_sha` = accepted spec; `run.configRef` present | validate | yes |
| Gate ownership: `gate.accepted` actor holds owning role; actor is human | accept path + validate | yes |
| High-risk gate 3 accept only via code-owner merge of plan PR | accept path (disabled) + validate (event source must be `pr.merge`) | yes |
| `risk`/`kind` immutable at stage ≥3 | validate on diff | yes |
| Stage 4 auto-advance only on green run whose fingerprint matches current config | engine | yes |
| Incident-loop change cannot pass stage 4 until its `INC` case is active | engine/validate | yes |
| plan-sync: commit files ⊆ plan files or plan in same commit | hook (commit) | yes (managed) |
| test-freeze: no edits to `testGlobs` while `repro.state=committed` and stage ∈ {3,4}; single-file lift once | hook (edit) | yes; fallback = auto-finding blocking merge |
| verify-before-done: done only if last round green with output attached | hook (stop) + `report_done` | yes |
| Session start requires target; mode ≤ eligibility; backlog ≤ ceiling | server | yes |
| Eval config gate: PR touching `CLAUDE.md`, `.claude/**`, model pin requires run verdict ≥ threshold; `incomplete` ≠ pass | CI required check | yes |
| Active eval case has ≥1 check; draft cases excluded from pass rate | validate | yes |
| Linked mode: accept blocked until record id + commit SHA present | accept path | yes |
| Dismissals (triage, finding, proposal) require a reason | server/CLI | yes |
| Duplicate ids across branches | validate | yes |
| Hook lint: `ask` in edit/command phase → warning; must-hold skill without hook → warning; multi-step verification command → warning; suite < 20 → warning | Config view | no (advisory) |
| Staleness: artifact edited after next artifact's first commit; `spec.md` newer than accepted plan; CLAUDE.md over one page | validate + metrics | no (flag + count) |
| Broken links: record url unreachable, PR missing, file references in plan not in repo | validate (async) | no |
| Code/spec drift: `planMatches=false` surfaced at gate 5 | PR panel | no — reviewer judgment, but recorded |
| Detection tiers: agent tools limited to `bands.yaml` tier; 3σ routes only PR/runbook | launcher manifest + managed permissions | yes |
| Agent identity never code owner; no push to default branch | branch protection + settings | yes |

### 11.2 Deliberately left to human judgment (not enforced by software)
- Whether an intent is worth pursuing; whether the spec solves the stated problem; carrying forward vs resolving open questions.
- Risk classification (routine / high risk) and `kind`.
- Plan quality ("could an engineer who never saw the conversation implement it?").
- Whether a repro test "fails for the right reason".
- Whether to add guidance, raise the round cap, or take over a stalled loop.
- Review approval — findings inform, never decide (playbook Stage 5 step 3).
- Dismissal reasons and band tuning; whether a non-discriminating eval is retired or hardened.
- Accepting a CLAUDE.md proposal (code owners) and skill changes (policy owners).
- Release authorization to production.
The software's obligation for each is to present the evidence, record the decision with identity and time, and never offer a bypass that removes the human.

---

## 12. Storage and Version Control

### 12.1 Directory structure (product repo)

```
CLAUDE.md                       # harness working knowledge (parsed, never edited by console)
REVIEW.md                       # review policy
bands.yaml                      # control bands (Maintain)
.claude/
  settings.json                 # team hooks + permissions
  hooks/{plan-sync,test-freeze,verify-before-done,production-gate}.sh
  skills/<name>/SKILL.md
  agents/<name>.md
evals/
  cases/<CASE-ID>.json
  runs/<RUN-ID>.json            # summaries; big outputs under runs/<RUN-ID>/ with size cap
  check.sh
sdlc/
  config.yaml                   # roles, thresholds, records mapping, evals.mode, products
  templates/{intent,spec,plan,incident}.md
  counters.yaml                 # optional; ids are derived from directory scan by default
  changes/
    CHG-0042/
      change.yaml
      intent.md
      spec.md
      design/                   # optional mock(s)
      plan.md
      tasks.yaml
      evals/
        run-1.json  run-2.json
        final-round.json  screenshots/  repro.json
      pr.yaml
      deploy.yaml
      incident.md
      log.jsonl                 # append-only ledger (merge=union)
      cycles/1/ …               # archived artifacts of previous loop cycles
  loop/triage/TRI-0042.md
  security/findings/SEC-0118.yaml
  proposals/PRP-0007.yaml
.gitattributes                  # sdlc/**/log.jsonl merge=union
.sdlc-state/                    # gitignored cache (sessions, snapshots, parsed config, job queue)
```

### 12.2 Naming and IDs
- `CHG-NNNN`, `TRI-NNNN`, `SEC-NNNN`, `PRP-NNNN`, `INC-NNNN` (eval case source ids), `CASE-…`, `RUN-…`. Zero-padded 4 digits (the spec's 2–3 digit seeds are a display artefact of small seed data). Ids are allocated as `max(existing on default branch and all local branches) + 1`.
- Artifacts keep the playbook's exact filenames so skills, prompts and humans find them.
- Branches: `sdlc/CHG-0042/intent`, `/spec`, `/plan` for artifact PRs; task branches `CHG-0042/<task-slug>` (worktree name = branch name, satisfying the Sessions card "mono worktree name").

### 12.3 Schemas and front-matter
Every markdown artifact has YAML front-matter with at least `id`, `artifact`, `cycle`, `author`, `created`, and the upstream SHA field (`intent_sha`/`spec_sha`/`plan_sha`), plus `context_manifest` when agent-produced. Schemas live in the core package and are versioned (`schema: 1`); files declare their schema version for forward migration.

### 12.4 Git behaviour
- The console commits with the acting human's identity (local git config; in hosted mode a verified identity via the GitHub App's "on behalf of" author field), agent commits under the agent identity, system commits under `sdlc-bot` with a trailer naming the triggering event id.
- Commit message convention: `sdlc(CHG-0042): accept plan.md (gate 3)` — prefix, id, event; trailers `SDLC-Event:`, `SDLC-Actor:`.
- One event per commit for decisions; artifact + event in the same commit for commits/acceptances so history is atomic.
- `log.jsonl` uses the `union` merge driver; event ids make replay idempotent.

### 12.5 Commit relationships
`intent` commit ← `spec` commit (front-matter SHA) ← `plan` commit ← task commits (plan-sync ensures plan updates ride along) ← eval run files (reference worktree head) ← PR (head SHA) ← merge commit (`gate.accepted{5}`) ← `deploy.yaml` ← `incident.md` ← cycle archive. `sdlc audit` walks this chain.

### 12.6 Branching
- Local mode: artifact acceptance commits directly to the default branch by the gate owner.
- GitHub mode: every artifact is a PR; acceptance = merge; send-back = "request changes" review + `gate.sent_back` event on the PR branch. Code commits always on task branches; only the system opens the code PR.
- Worktrees: one per task; removed after merge (`sessions archive`).

### 12.7 History and conflict handling
- Artifact history = git history of the file; "rework" metrics read it.
- Cycle archives preserve prior artifacts as files (not only in history) so agents can read "what happened last time" from the tree.
- Conflicts: `log.jsonl` never conflicts (union); artifacts conflict only if two humans edit the same artifact concurrently — surfaced as a normal PR conflict; ids conflict only across offline creators — validator blocks, `sdlc change renumber` fixes.

---

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

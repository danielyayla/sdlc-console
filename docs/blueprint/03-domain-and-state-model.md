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


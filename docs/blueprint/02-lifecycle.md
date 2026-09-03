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


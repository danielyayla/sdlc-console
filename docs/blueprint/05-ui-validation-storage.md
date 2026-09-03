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


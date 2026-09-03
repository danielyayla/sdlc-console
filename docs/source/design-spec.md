# Source: Veri · SDLC Console — Design & Implementation Spec v1.0 (2026-09-02)

The product-intent source document, condensed but with every rule preserved. `docs/blueprint/` was derived from it plus the playbook (`playbook.md`). Where §7 "out of scope" (auth, persistence, real git/CI) conflicts with the blueprint, the blueprint wins — see `docs/decisions.md` Q1.

## 1 · Product model
Every change moves through six stages, each committing one artifact. A stage ends at a human gate (one named decision, one owning role) or auto-advances. Accepting the stage-6 gate loops the change back to stage 1 — closed, never terminal.

| # | Stage | Artifact | Gate (label · owner) | On accept |
|---|---|---|---|---|
| 01 | Plan | intent.md | Accept intent.md · product owner | → 02 |
| 02 | Design | spec.md | Approve spec.md · product owner | → 03 |
| 03 | Build | plan.md | Accept plan.md · engineer | → 04 |
| 04 | Test | evals | none — auto on green | → 05 |
| 05 | Deploy | PR + findings | Merge PR · engineer | → 06 |
| 06 | Maintain | incident | Accept incident intent · product owner | → 01 (loop) |

Roles: product owner (1, 2, 6), engineer (3, 5). One active role at a time via top-bar switcher; gate actions enabled only for the owning role, else "waiting on the <other role>" + hint to switch.

## 2 · UI seed data model (storage model is blueprint §5/§12)
```
Change { id "CHG-0NN", title, stage 1..6, risk "routine"|"high risk", agent: bool, status,
         gate: {s: 1|2|3|5|6, since} | null, docs: {[0..5]: string}, activity: [{agent, text, time}] }
TriageItem { id "TRI-0NN", tier "3σ"|"incident", src, title, evidence, intent }
Finding { id "SEC-1NN", sev High|Medium|Low, conf "validated · 0.NN", repo,
          status new|"patch in PR gate"|"escalated → intent"|dismissed, title, desc }
UIState { view board|detail|gates|sessions|config|loop|security|metrics, role po|eng, sel, art, toast }
```
Artifacts 0–5: intent.md, spec.md, plan.md, evals, PR + findings, incident. Sparse docs map. Seed: 8 changes (2 Plan, 1 Design, 2 Build, 1 Test, 1 Deploy, 1 Maintain), 2 triage, 3 findings, 4 sessions.

## 3 · Layout & navigation
Full-viewport: fixed 44px top bar + scrollable region; one view enum, no router. Top bar: brand (18px orange square, "Veri / invoicing / SDLC console", mono repo segment); tabs Pipeline · Gates · Sessions · Config · Loop · Security · Metrics; right: ACTING AS two-segment switcher. Badges (amber pill, mono): Gates = open gates owned by active role; Loop = triage length; Security = findings "new"; hidden at 0. Pipeline stays highlighted in detail. Tab switch clears selection; role switch never changes view.

## 4 · Views
**Pipeline (default).** 6 columns `grid repeat(6, minmax(200px,1fr))`, min-width 1280, horizontal scroll below. Header: mono orange number + name + count; caption "commits <artifact>". Empty "Nothing here". Card: mono orange id; pulsing ⌁ chip when agent; 13px medium title; muted status; amber gate strip (dot + label + OWNER) when gate open. Click → detail; hover lightens one step.

**Change detail.** Max 1120. "← Pipeline"; id, 22px title, stage chip, risk chip (amber if high). Stepper: 6 nodes joined by "→": dot + mono name + caption. Dots: committed #7FAF8A · in review #D9A03F · in progress #E8703A pulsing · future #3F3D47 · draft (plan) orange pulsing "draft rev N". Click selects artifact; default = current stage; reset on advance. Body 1fr/330px. Viewer: mono filename + committed/pending (+ "draft (rev 3)", "authoritative", "copy of JIRA-123 · synced 2h ago"), pre-wrap mono body min-height 220, empty "Not committed yet — this artifact is produced when the stage runs." Rail: Gate panel (amber; HUMAN GATE + waiting time; label; owner; owned → primary Accept ("Merge" on 5) + Send back; else dashed "Waiting on the <owner> — switch role in the top bar to act.") or No-gate panel (pulsing ⌁, NO GATE OPEN, status, "The next human gate opens when the artifact is committed."); Activity newest first, ⌁ orange agent / ● green human, relative time.

**Gates.** Max 820. YOURS · <ROLE> (amber eyebrow) and OTHER ROLE (65% opacity). Row: amber dot (yours) · id · label + "title · stage" · "waiting <since>" · →. Empty: "Queue clear — nothing waiting on the <role>."

**Sessions.** Max 960, 2-col. Card: dot (orange pulsing active / dark idle) + mono worktree + mode chip (AUTO green, PLAN MODE amber, HEADLESS gray); change-id chip + task; status; subagent chips; green-left-border auto-accept rationale. Footer callout: repo-config controls, per-engineer logging.

**Config.** Max 1020. Eval-gate banner (green chip, suite number + pass %, "Run suite"). CLAUDE.md card (version, "under one page", freshness, working rule + last entry) + subagents (name · description · tools). Tables: Skills (name, trigger, owner, version, pass %); Hooks (name; action chip block red/ask amber/allow green; description; phase; scope managed orange/team gray); footer "Managed hooks are deployed by the platform team — engineers cannot switch them off."

**Loop.** Max 920. Bands table METRIC/BASELINE/CURRENT/TIER/ACTION/STATUS (amber when breached); footer "bands.yaml · rolling 30d baseline · Western Electric rules · 1σ log, 2σ diagnose read-only, 3σ propose via PR or pre-approved runbook." Triage cards: id, tier chip, src; title; evidence; Accept → Plan / Dismiss · tune band. Accept removes item AND creates Change at stage 1 with the pre-drafted intent, gate 1 open, status "Intent drafted via <src>", toast "CHG-0NN created — waiting at the Plan gate". Empty: "Queue clear — the loop is feeding itself."

**Security.** Max 920. Subhead: cadence, repo count, last run, validated + confidence. Card: severity chip (High red / Medium amber / Low gray), id, confidence, status; title; desc + repo. While "new": Patch → PR gate (status "patch in PR gate", no new Change, toast "…review gate decides"); Wider than one patch → intent.md (status "escalated → intent" AND new Change at stage 1 with intent from the finding incl. an eval for the vulnerability class); Dismiss with reason (status dismissed, 50% opacity, actions hidden). Footer: fixes reach production only through PR review + branch protection; proposing agent cannot approve its own fix; deterministic checks stay in CI.

**Metrics.** Max 1020, 2-col, card per stage: number + name + trend chip (▲ green / — gray / ▼ amber); LEADING and LAGGING halves, 19px tabular-nums value + note. 30-day window.

## 5 · Interactions
- Accept/Merge (owner only): prepend "You (<role>): <gate label>"; clear gate; stage +1 (6→1); agent = true; status "Agent producing <next artifact>" (or "Loop closed — re-entered Plan from incident"); reset artifact selection; toast "<gate label> — <id> moved to <stage>".
- Send back: prepend "You sent <artifact> back with feedback"; clear gate; keep stage; agent = true; status "Agent revising <artifact> per feedback"; toast.
- Change creation: next id, prepended, stage 1, gate 1 open, docs {0: intent}, one activity entry.
- Toast: single bottom-center pill, green check, 2.6s, new replaces old.
- All mutations immutable; badges/queues recompute every render.

## 5A · Stage 3 Build
Change += { planRev, planState none|draft|committed, planMatches bool|null, autoEligible (derived), record {system,id,url}|null }.
- Draft: stepper draft state; each rewrite logs "⌁ drafted plan.md rev N"; engineer questions log "● You asked: …".
- Gate 3 opens when agent posts a draft marked final. Accept → committed, rev frozen, accepted-by + time, session PLAN → AUTO or SUPERVISED per eligibility. Send back → stays draft.
- High-risk: label "Accept plan.md · tech lead"; engineer sees dashed "Waiting on tech lead — approval happens via PR review on plan.md" + PR link, no Accept, Send back available. Code-owner merge → gate clears, "● Tech lead (via PR) accepted plan.md", → 04. Risk set in 1/2 by PO, read-only from Build.
- Plan/diff sync: managed hook plan-sync (commit, block): files outside plan.md "Files that change" fail unless plan.md in same commit; sets planMatches; Stage 5 reads it.
- Auto eligibility (derived, never a toggle): spec committed ∧ routine ∧ files-in-plan ≤ threshold ∧ eval coverage for paths ∧ verification block present. Override AUTO → SUPERVISED only.
- CLAUDE.md: two send-backs or hook blocks with the same reason → proposed line ("from CHG-04, CHG-07", Accept opens PR with "pending review" chip, Dismiss); word count vs one page, amber over. Counts feed Stage 3 metrics.
- Skills: pass % = share of trigger-test prompts that loaded the skill; below threshold → amber + triage "skill not triggering". Backed-by column: hook name or "advisory" amber; must-hold with no hook flagged. Skill changes are PRs with policy owner reviewer; Stage 5 findings citing the policy counted onto the row.
- Hooks: ask in edit/command → "approval prompt in build — move to PR gate". Every block logs "⌁ hook <name> blocked …" and feeds the repeat signal.
- Parallel sessions: on plan accept agent proposes tasks from the file list; overlaps merged "sequential · shared files"; engineer confirms → one worktree + card per task, all carrying the change id. Card additions: file set; "waiting on you" amber; last verifier result (ran / saw / mismatch). Header "N active · review backlog M"; over limit disables New session with reason. Subagents read-only with file link. Handoff: worktree → eval run → PR.
- Source of truth (5A.6): Config → Records row per artifact: repo | external | linked + connector. Header record chip; viewer "authoritative" / "copy of … · synced …". external: Accept writes back via MCP; failure → stays accepted, amber "write-back failed · retry". linked: Accept blocked until record id + commit SHA present.
Acceptance: (g) high-risk in Build shows tech-lead notice, no Accept; (h) routine plan accept flips session to AUTO with rationale; (i) commit outside plan file list blocked, planMatches = false.

## 5B · Stage 4 Test
Repo.verification { commands [{name build|test|lint|visual, cmd, healthyOutput}], testGlobs, visualTool mcp-browser|screenshot-cli|null, maxLoopRounds 5 } parsed from CLAUDE.md "Verifying your work"; console parses, never edits. Missing → "no feedback loop — set up verification", no AUTO. Multi-step command → "wrap in one target". No visual tool + plan touches UI paths → "UI work without a visual check".
Feedback loop: Session += { target (required; prefilled from plan acceptance line; hint "quantifiable: which tests, which endpoint, which mock"; missing → "waiting on you: define done"), loop { rounds [{n, ts, results [{name, pass, outputExcerpt}], screenshot?, diffPct?}], state not-run|iterating|green|stalled|flaky } }. Each round logs "⌁ round 3 · build ✓ test ✗ (2 failing) lint ✓"; loop and verifier never merged. Visual rounds strip; click opens screenshot beside mock; 2–3 rounds normal. Stalled: rounds > max, or same failing test 3 rounds → stop, "waiting on you: loop not converging" + last output; Add guidance / Raise round cap once / Take over; nothing auto-passes. Flaky: fail then pass with no file change → still red, triage "flaky check: <test>". Setup failure → not-run, "setup needed", verbatim output. Managed hook verify-before-done (stop, block): complete only if latest round all-green with output; block logs "⌁ hook verify-before-done blocked completion — test red". Final green round = evals artifact body + PR check run above Accept/Merge.
Fix tasks: Change.kind feature|fix (incident-loop → fix); Change.repro { state none|drafted|confirmed|committed, testPath, failureReason, sha }. Stepper Build splits repro → fix. Session starts in repro: writes test, runs, posts failure; "⌁ repro test fails: <reason>". Inline card: path · output · "Fails for the right reason → commit" / "Wrong failure — send back" (engineer only; PO read-only). Confirm commits the test alone (sha), fix phase begins with freeze. Managed hook test-freeze (edit, block): while repro committed and change in Build/Test, edits to testGlobs blocked; logs "⌁ hook test-freeze blocked edit to tests/…"; test-edit attempts counter red if > 0. No managed hooks → Stage 5 auto-finding "diff touches a test file during a fix" blocks Merge until dismissed with reason. PR panel: "repro test committed <sha> before fix · unchanged in diff ✓" (or red). Agent may only propose test changes → send-back-style card; engineer edits manually or lifts freeze once (logged).
Per-change run: on session completion, run intersecting eval cases + verification commands, non-interactive; "Evals running · N cases". Green → 04→05 no click, "⌁ evals green (N/N) → PR opened". Red → stays 04, "Evals red — agent fixing", re-enters with failing output; two reds → waiting on you. Never a bypass. Evals viewer: run (cases · pass/fail · output), final round evidence, repro proof; header carries config fingerprint (CLAUDE.md sha, skill versions, model).
Eval suite: EvalCase { id, prompt, checks[], source {type change|incident|manual, ref}, owner, added, status draft|active|retired, passHistory }; EvalRun { id, trigger schedule|config-pr|manual, configRef {claudeMd, skills, hooks, model}, results [{caseId, pass, output}], passRate, threshold, verdict, cost }. Config → Evals: suite size (amber < 20 "under-sized"), pass % vs threshold, 30-run strip (hover: configRef diff), budget used/remaining; "Run suite" real trigger (queued → running). Case table: id · prompt · source chip · owner · status · sparkline; filters; draft "checks missing", excluded. Config-change gate: PR touching CLAUDE.md, .claude/**, model pin → run as required check; below threshold blocks merge, lists regressed cases with before/after; approver = team owning the config; no new console gate. Harvest: post-merge "Add as eval" (prompt = intent + acceptance line, checks = verification commands + "behaviour unchanged"; draft, platform owner); incident loop creates INC-xx draft (incident team); the incident's change cannot pass Stage 4 until active; metrics track incident→active. Live suite: 100% over N runs (default 20) → "no longer discriminates" triage item (retire-or-harden; retire keeps history); failing 3 runs no config change → "broken check". evals.mode continuous|scheduled; scheduled disables config-PR trigger, banner amber "next run <time> · config PRs not gated". Over budget → stopped, "incomplete", never counts as pass.
Governance: verify-before-done and test-freeze in Hooks table, scope managed. Evidence = literal output on evals artifact + PR check run; console displays, never summarises. Logged in session transcript (OTel) and activity feed. Stage 4 metrics: leading — first-pass CI success for agent PRs, eval pass trend, incident→active eval time; lagging — review time per PR, change failure rate, regressions caught in CI vs production.
Acceptance: (j) test-red session cannot report complete, card shows blocked stop; (k) fix change shows repro card; after confirm, test edit blocked and counted; (l) green run moves 04→05 with no click, red keeps 04 and re-enters; (m) CLAUDE.md PR shows suite verdict + regressed cases; (n) incident loop creates draft eval case the change must activate before passing Stage 4.

## 6 · Visual language
Dark, dense, terminal-adjacent. Source Sans 3 UI (14px); JetBrains Mono ids/filenames/eyebrows (9.5–12px, eyebrows .08em uppercase). Radius 4px chips / 6–8px controls, cards / 10px panels. 1px hairlines; elevation by background steps; toast shadow 0 12px 32px rgba(0,0,0,.5).

| Token | Hex | Use |
|---|---|---|
| bg/app | #0F0F11 | page |
| bg/panel | #131316 | cards, columns, top bar |
| bg/raised | #17171B | nested cards, table headers |
| bg/hover | #1B1B20 | hover, active tab, chips |
| border/subtle | #1E1E24 | dividers |
| border/default | #26262C | card/control borders |
| text/primary | #E7E4DE | titles, values |
| text/secondary | #C9C6CF | body, artifact text |
| text/muted | #A09DA6 | descriptions, inactive tabs |
| text/faint | #6E6B76 / #55525E / #4A4852 | captions, timestamps, empty |
| accent/kiln orange | #E8703A | brand, ids, agent, primary buttons (hover #F49463, text #0F0F11) |
| signal/gate amber | #D9A03F | gates, badges, breaches (tints 5–12% alpha) |
| signal/green | #7FAF8A | committed, pass, human |
| signal/red | #D96459 | High severity, block hooks |
| inactive dot | #3F3D47 | future nodes, idle |

Semantic rule: orange = agent/brand; amber = waiting on a human; green = human-confirmed/passing; red = severity/blocking. Never mix. Only animation: kilnpulse (2s opacity 1 → .35 → 1) on active agent work. Buttons: primary orange fill, dark text, 27–30px, 6–7px radius, 600; secondary 1px border, hover #1B1B20. Real `<button>` elements.

## 7 · Config & acceptance
`defaultRole: "po"|"eng"` (default po), seeds switcher on load only. Viewport ≥ 1280×800. Acceptance (a)–(f): (a) gate 1 on CHG-022 → Design, intent.md committed-green; (b) incident gate on CHG-012 loops to Plan with "loop closed"; (c) TRI-042 accept creates a change in Plan, Loop badge decrements; (d) SEC-118 escalate creates a change AND marks finding escalated, Security badge decrements; (e) role switch flips actionable panels and swaps Gates lists; (f) send-back keeps stage, re-enters agent revision. No drag-and-drop between columns; no mobile layout.

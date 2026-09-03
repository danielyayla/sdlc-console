# Source: The AI-Native SDLC Playbook (Anthropic, 2026-08-21)

Canonical: https://claude.com/blog/the-ai-native-sdlc-playbook

Not reproduced here (third-party content) — fetch it when you need the original wording. The operating-model requirements the blueprint extracted from it:

- Six stages (Plan, Design, Build, Test, Deploy, Maintain) form a **loop**, not a line. Each stage ends by **committing one artifact** and the next begins by reading it: `intent.md` → `spec.md` → `plan.md` → diff + tests → PR + review findings → incident record → new `intent.md`.
- **The chain of commits is the audit trail:** who asked, what the agent produced, who approved.
- **Humans decide at gates**; agents work between them. The agent that wrote code has no route to approve it (branch protection, code owners).
- **Plan:** originator brainstorms with an agent, commits `intent.md` (problem, outcome, affected users/systems, constraints, open questions) to a version-controlled intent home; PO accepts/rejects.
- **Design:** one agent session turns `intent.md` into `spec.md` under org skills (brand/security/compliance/UX), concerns flagged; PO reviews and resolves concerns with policy owners; high-risk consults a tech lead; accept starts plan mode.
- **Build:** plan mode first (read-only), interview, commit `plan.md` (files, order, risks, proof); implement; plan.md updated in the same commit when implementation departs (hook). Auto mode for routine work once guardrails mature. `CLAUDE.md` under one page; "mistake twice → CLAUDE.md". Skills are advisory; hooks are the deterministic layer behind them; `ask` hooks belong at gates, not in build. Parallel sessions in worktrees; subagents in `.claude/agents/`; ceiling = review capacity. Per artifact, name one source of truth (repo / legacy system / linked).
- **Test:** give the agent a feedback loop (single-command build/test/lint with healthy output in `CLAUDE.md`, quantifiable target, visual check for UI, verify before "done", failing-test-first for fixes with a hook blocking test edits). Continuous evals in CI run on `CLAUDE.md`/skills/hooks/model changes and gate them; every incident becomes an eval; the suite is live.
- **Deploy:** agent reviews PRs per `REVIEW.md` (bugs, security, compliance vs spec/plan); findings inform, humans approve. Hooks as approval gates (allow/ask/block), managed settings non-overridable. Agent acts up to the production gate, never past it; sandboxed; deploy/rollback via MCP per environment; rehearsed rollback.
- **Maintain:** deterministic detection + `bands.yaml` tiers (1σ log, 2σ diagnose read-only, 3σ propose via PR/runbook); findings become `intent.md` in a triage queue; dismissals tune bands. Recurring security scans: bounded → PR gate, wider → `intent.md`, dismiss with reason; eval per vulnerability class. Channel-driven triage via Claude Tag.
- Every play defines leading and lagging metrics readable from git, PR metadata, CI, OTel and the incident tracker.

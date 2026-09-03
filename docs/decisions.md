# Decisions — read this before any architectural choice

Resolved defaults from blueprint §2 (principles) and §17 (open questions). Do not re-litigate these mid-build; if one turns out wrong, change this file in a commit that says why.

## Principles (non-negotiable)
1. **Files in git are the source of truth; the console is a projection.** No lifecycle fact exists only in the app.
2. **Stage is derived, never stored.** `stage` is a pure function of accepted artifacts + eval verdict.
3. **A gate decision is a human-authored git commit** (a PR merge in GitHub mode). Agents have no code path to accept/merge/approve.
4. **Deterministic checks are code; judgment is human.** No auto-pass, no bypass button.
5. **Evidence is literal toolchain output**, displayed verbatim.
6. **Orchestration ≠ inference.** The console never calls a model; it launches and observes harnesses (Claude Code first) and records the model as a variable.
7. **The console parses repo config (`CLAUDE.md`, `.claude/**`, `REVIEW.md`, `bands.yaml`); it never edits it.**
8. **No approval prompts inside build sessions.** Approvals live at PR/production gates.
9. **AUTO mode is derived eligibility**; humans may only downgrade.
10. **Local-first, hosted-capable.** Everything works against a local clone with no network first.
11. **No database.** SQLite only as a disposable, rebuildable cache under `.sdlc-state/`.
12. **Core package has no I/O.** Pure functions over a `Tree` snapshot; adapters do I/O.

## Resolved ambiguities (blueprint §17)
| # | Question | Decision |
|---|---|---|
| Q1 | Spec §7 says auth/persistence/git are out of scope | Applies to the reference HTML only. Build on real git from Phase 0; defer auth to Phase 3. |
| Q2 | Loop = same change or new change? | Both. Gate-6 accept → same id, `cycle+1`, previous artifacts archived under `cycles/<n>/`. Triage/security accept → new change with `origin` link. |
| Q3 | Who is the gate-5 "engineer"? | Role `eng` owns it in the UI; the merge executes through branch protection, which decides code-ownership. |
| Q4 | Tech-lead consult at gate 2 for high-risk | One owner per gate. Record a `consult.tech_lead` event required before gate-2 accept when risk = high (Phase 2 rule). |
| Q5 | Where gate-1 acceptance is recorded | Always `gate.accepted{1}` in `log.jsonl`; local mode commits to default branch, GitHub mode merges the intent PR. |
| Q6 | Intent home | `sdlc/changes/<id>/` co-locates all six artifacts. `intentHome` config for a separate repo later. |
| Q7 | Session mode names | PLAN = harness plan mode; SUPERVISED = default with prompts; AUTO = auto-accept under managed permissions; HEADLESS = `claude -p`. |
| Q8 | Spec's `Change.docs` bodies, string timestamps, shared counter | UI seed model only. Bodies are files; ISO timestamps in front-matter; ids by directory scan on default branch + local branches. |
| Q9 | "Eval coverage exists for those paths" | An `active` eval case whose `paths[]` matches every planned file, OR verification includes a test target whose globs cover them (config `eligibility.coverage: strict|lenient`). |
| Q10 | Evidence size in git | Commit final-round output/screenshots under 1 MB per file (images ≤ 500 KB); larger → CI artifact with hash + URL. |
| Q11 | Who runs the headless design pass | CI job on intent merge; skills from repo or pinned plugin marketplace. |
| Q12 | Security findings source of truth | Scanner owns the finding; console owns routing status + dismissal reason in `sdlc/security/findings/*.yaml`, matched by scanner id. |
| Q13 | Metrics | Derived from real sources; "n/a · needs <source>" when missing. Seed numbers only in fixtures. |
| Q14 | Clock authority | Commit timestamps for gate `since`; session events carry harness wall time + per-session sequence. |
| Q15 | Two personas vs many responsibilities | Role switcher = view. Extra roles declared in `sdlc/config.yaml` and only gate specific non-gate actions / PR reviews. |

## Stack (fixed)
TypeScript, Node ≥ 22, pnpm monorepo. Packages: `schemas`, `core`, `adapters/git`, `adapters/github`, `server`, `cli`, `mcp`, `hooks`, `web`. React + Vite, plain CSS variables. Real `git` CLI via a thin wrapper. JSON Schema (Ajv) + zod types, `gray-matter` for front-matter. better-sqlite3 cache. MCP TypeScript SDK. Vitest.

## Decisions made during build
Choices the blueprint and the sections above did not settle, recorded as they were made. Each names the item that forced it.

| Item | Decision |
|---|---|
| 0.1 | ESM everywhere (`NodeNext`), `tsc -b` project references, tests import workspace packages from source via a Vitest alias. `packages/core` may depend only on `@sdlc/`-scoped packages; ESLint bans every Node builtin in `packages/core/src/**`. |
| 0.2 | zod is the authoring source of truth; JSON Schema 2020-12 is generated from it (`z.toJSONSchema`) and committed under `packages/schemas/json/` for MCP tool schemas and non-console writers; Ajv compiles the generated schema for runtime validation. A test fails when the committed JSON drifts from the zod source. |
| 0.2 | Two ledger invariants are encoded in the event schema itself, not only in the rule engine: `gate.accepted` and `gate.sent_back` require a human actor; `stage.entered` and `cycle.archived` require the system actor; agent actors require a `session`. |
| 0.2 | Stored enum spellings: `risk: routine|high`, `kind: feature|fix`, `sev: high|medium|low`, finding `status: new|patch_pr|escalated|dismissed`, triage `status: open|accepted|dismissed`. Display strings ("high risk", "patch in PR gate") are a UI concern. Session modes keep the Q7 upper-case names. |
| 0.2 | `change.yaml` carries `record`, `repro`, `closed` as required-but-nullable, matching blueprint §5.2. Threshold defaults live in `CONFIG_DEFAULTS` (schemas) and are applied by core, never written back to `config.yaml`. |
| 0.2 | `pr.yaml` has `provider: github|local` so local mode can record a branch merge without a code host; `number`/`url` are optional for that reason. |
| 0.2 | Schemas beyond the 0.2 list (`pr.yaml`, `deploy.yaml`, per-change run, final round, repro proof) were added now because Phase 1 writes those files and every `sdlc/` file must have a schema. |

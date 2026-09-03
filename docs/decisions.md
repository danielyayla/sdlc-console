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
| 0.3 | Parsers live in `@sdlc/schemas` (the blueprint's "schema / parser layer", §7.2) because they need `gray-matter` and `yaml`, which `packages/core` may not depend on. Front-matter YAML is parsed with the `yaml` core schema so timestamps stay strings. |
| 0.3 | `CLAUDE.md` "Verifying your work" line grammar: `- Build\|Test\|Lint\|Visual: \`cmd\` (healthy output)`, `- Test files: \`glob\`, …`, `- Max rounds: N`. A command chaining `&&`, `;` or `\|` is not single-target. "Under one page" = 600 words (`ONE_PAGE_WORDS`). |
| 0.3 | Artifact completeness: a required `##` section that is absent is an error (`artifact.section.missing`); one whose body is blank, `<placeholder>` or a bare list marker is a warning (`artifact.section.empty`). The gate-open rule (0.6) treats both as blocking; drafts stay inspectable. |
| 0.3 | `.claude/settings.json` hook rows: command hooks are `block` (exit 2 blocks); `permissions.deny/ask/allow` map to `block/ask/allow` rows so the "ask in edit/command phase" lint has something to see. Hook names come from `sdlc hook <name>` or the script basename. Phases for the four managed hooks are fixed by name. |
| 0.3 | `bands.yaml` shape: `metrics[]{metric, baseline, unit?, rules?, tiers{1sigma{action:log}, 2sigma{action:diagnose, tools[]}, 3sigma{action:propose, routes[]}}}`, plus `baselineWindow?` and `runbooks?` (the allowlist). |
| 0.3 | `bands.yaml` `tiers` keys are `1sigma`/`2sigma`/`3sigma` (ASCII) in the file; the UI renders σ. |
| 0.4 | Gate open/closed for gates 1, 2, 3, 6 is decided by the latest of `artifact.committed{idx}`, `plan.final`, `plan.drafted` (gate 3 only) and `gate.sent_back{gate}` in the current cycle: committed/final opens, drafted/sent-back closes. A present artifact with no events at all counts as open (hand-written fixtures). Gate 5 is open whenever `pr.yaml` exists unmerged; `since` = `pr.yaml.openedAt`. |
| 0.4 | `gate.since` uses the opening event's `ts` (the accepting commit writes the event, so it equals the commit time within a second); no commit-graph walk is needed in core. |
| 0.4 | Stage 4 evaluates only `sdlc/changes/<id>/evals/run-<n>.json`: a green run counts when its `configRef` matches the tree's `CLAUDE.md`, `.claude/settings.json` and `SKILL.md` blob shas. The model is recorded, never matched (it is not in the tree). Two consecutive red runs → `waiting on you`. |
| 0.4 | Derivation inconsistencies are validation errors that remove the change from every queue: gate accepted out of order, gate 6 accepted without `cycle` advancing, accepted gate whose artifact is missing, green evals with no `pr.yaml`, high-risk gate 3 accepted with `source ≠ pr.merge`. |
| 0.4 | Lenient eval coverage (Q9) holds when every planned path has an active case OR the verification block has a `test` command; strict requires the case. |
| 0.4 | `planMatches` follows the last `plan-sync` hook decision in the cycle (`hook.allowed` → true, `hook.blocked` → false), falling back to `pr.yaml.planMatches`, else null. |
| 0.4 | `products[]` nesting of `sdlc/` per product is not implemented in `loadRepo`; one `sdlc/` tree per repo until a monorepo needs it. |
| 0.5 | A `WritePlan` is `{changeId, files[{path, content|null}], events[{changeId, event}], commitMessage, trailers, actor}`. Events are appended by the adapter to that change's `log.jsonl`; deletes apply before writes. `applyWritePlan(tree)` gives tests and the filesystem adapter the same semantics the git adapter must implement. |
| 0.5 | Transitions take a `TransitionContext {now, newId, actor: HumanIdentity, mergeSha?, knownIds?}`. There is no agent-shaped context, so `accept`/`sendBack`/`loop`/`confirmTasks`/`confirmRepro` are unreachable by agents at the type level; ownership is checked against `sdlc/config.yaml` identities and refused when the config is missing. |
| 0.5 | `config.codeHost: local|github` (default local). High-risk gate 3 in local mode is accepted via CLI by an identity holding `tech_lead` (event `source: cli`, actor role `tech_lead`); in github mode only `source: pr.merge` is valid. |
| 0.5 | Gate 5 in local mode: the adapter merges the task branch first and passes `mergeSha`; the write-plan records `pr.yaml.mergedAt/mergeSha` and events `gate.accepted{5}`, `pr.merged`, `stage.entered{6}` in one commit. |
| 0.5 | `loop` archives every file of the closing cycle except `change.yaml`, `log.jsonl` and `cycles/` under `cycles/<n>/`, sets `kind: fix` and `repro: null`, seeds `intent.md` by mapping incident sections (Anomaly → Problem, Affected systems → Affected users and systems), and drafts `evals/cases/INC-<CHG>-<n>.json` with the closing cycle's plan paths. The ledger is one file across cycles; events carry `cycle`. |
| 0.5 | Task split proposal groups plan files by directory; any two tasks sharing a file merge into one `sequential` task. Worktree = branch = `<CHG>/<slug>`. |
| 0.5 | `stage.entered` is written by the same commit as the gate acceptance (system actor), so history is explicit without a separate engine pass in local mode. |
| 0.6 | The validation engine returns `RuleDiagnostic {…, blocking, changeId?}`; `severity: error` ⇒ blocking. `validateTree` (whole tree), `validateChange`, `validateDiff(before, after)` (risk/kind immutable at stage ≥3, archived cycles and ledger append-only, changes never deleted), `validateIds(idsByRef)` (an id on two non-default branches is a duplicate), `validateWritePlan` (every event re-validated, then the tree after the plan). |
| 0.6 | An open gate on an incomplete artifact is a blocking diagnostic (`gate.artifact-incomplete`) and `accept` refuses it; derivation still shows the gate so the UI can explain why Accept is disabled. |
| 0.6 | A looped change (cycle > 1) is held at stage 4 by derivation until `evals/cases/INC-<CHG>-<n-1>.json` is `active`; status names the case. Past stage 4 with the case inactive is a blocking diagnostic. |
| 0.6 | The three managed hooks are pure functions in core (`check.planSync`, `check.testFreeze`, `check.verifyBeforeDone`) returning `{allowed, reason, offending}`; the hooks package (1.4) only adapts stdin/exit codes. plan-sync ignores `sdlc/changes/**` so ledger writes never trip it. |

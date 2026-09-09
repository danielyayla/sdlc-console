---
id: CHG-0001
artifact: spec
cycle: 1
intent_sha: 9e711b3b0cba7a7469bc9f4105fdc4c97dea8360
prompt_ref: prompts/design-pass@1
skills: []
concerns:
  - id: C1
    policy: intent.md Constraints / Affected systems — the Snapshot data contract stays as it is; docs/decisions.md principle 12 (core has no I/O, ChangeView is core's type)
    owner: po
    resolved: false
    note: "The done signal `grep chip packages/web/src` returns nothing cannot be met literally: packages/web/src/lib/format.ts reads ChangeView.docs[].record.chip, a core field (packages/core/src/derive.ts:58). Renaming it is outside packages/web. Proposed reading: the signal counts CSS selectors and class names only — `grep -rnE '\\.chip|\"chip|chip[ \"]' packages/web/src` returns nothing — and the record.chip read is exempt by name."
  - id: C2
    policy: "docs/decisions.md 1.2 — tokens.css carries every spec §6 token; intent constraint: semantic colour values unchanged"
    owner: tech_lead
    resolved: false
    note: "`--radius-chip: 0` (tokens.css:40) is a §6 token, not a `.chip*` rule. Deleting it satisfies the grep signal but changes the token set; keeping it breaks the literal grep. Tied to C1."
  - id: C3
    policy: 'plan-sync hook (FR-41, .claude/hooks/plan-sync.sh): every committed file must be in plan.md "Files that change"; intent.md Affected users and systems'
    owner: eng
    resolved: false
    note: The Pipeline headline needs `role` (handoff §Pipeline), so packages/web/src/app.tsx:197 changes to pass it. The intent's file list omits app.tsx; plan.md must list it or plan-sync blocks the commit. Still inside packages/web; routes and callbacks unchanged.
  - id: C4
    policy: CLAUDE.md Verifying your work — never skip or delete a failing test; fix the code, not the test
    owner: eng
    resolved: false
    note: "This change deliberately changes assertions in packages/web/test/render.test.tsx on the strings the handoff removes (its §Tests list). Rule for the build: every dropped assertion is replaced in the same `it` by the handoff's replacement string; no `it` block is deleted; the three named tests are added. test-freeze does not apply (kind: feature, no repro)."
  - id: C5
    policy: "CLAUDE.md Conventions — commit messages `sdlc(<scope>): <what>`; handoff — one commit per removal, message = the removals-log line"
    owner: eng
    resolved: false
    note: "Both cannot hold verbatim. Proposed: `sdlc(web): <removals-log line>` per removal, e.g. `sdlc(web): .env-strip → words in line 3`."
  - id: C6
    policy: AI-native SDLC playbook (docs/source/playbook.md) — evidence is demoted in weight, never hidden; Cybercab rule 6 — every label is a word
    owner: po
    resolved: false
    note: "Three states move from a word to colour: the `agent` word leaves Pipeline line 1 (edge `--agent` + pulse only), `invalid` keeps its word but loses the red edge, and a gate owned by another role is `--text-faintest` edge + faint line 3. Line 3 still carries `c.status` / the gate label, so nothing is colour-only, but the PO should confirm the agent word may go."
  - id: C7
    policy: docs/decisions.md preamble — if a decision turns out wrong, change this file in a commit that says why; rows 3.4 (Loop table, breached/warned tints) and 3.6 (board env strip, gate strip)
    owner: tech_lead
    resolved: false
    note: Rows 215 and 229 describe rendering this step replaces (bands `<table>` with tinted rows; `.env-strip` and gate strip on board cards). docs/decisions.md is outside packages/web; decide whether the amendment rides in this change or a separate one.
  - id: C8
    policy: CLAUDE.md Non-negotiables — evidence (command output) is shown verbatim, never summarised; docs/decisions.md principle 5
    owner: eng
    resolved: false
    note: "The `<pre class=evidence>` in Loop and Security loses its background and padding (handoff). Content, `white-space: pre-wrap` and the 220px scroll stay; no truncation, no hover reveal. Flagged because the evidence element is touched."
  - id: C9
    policy: intent.md Constraints — no new utilities beyond .edge-lit, .bar-lit, .hairline, .btn.text, .btn.primary, InlineReason
    owner: eng
    resolved: false
    note: "Security needs 'glow only while status === new' and Pipeline needs 'no glow for another role's gate'. `.edge-lit.off` already drops the glow; for a coloured edge without glow one scoped rule is proposed (`.security .item:not(.new)::before { box-shadow: none }`) rather than a new utility class."
  - id: C10
    policy: Cybercab rule 6 — every label is a word; docs/decisions.md 1.3/2.10 — trend rendered as a word in its state colour
    owner: po
    resolved: false
    note: The handoff and mock render trends as `▲ +9%` / `▼ -18%` glyphs. Spec follows the handoff (it is the specification per the intent) and keeps `title={fmtPrev(v)}`; the PO should confirm glyphs are the intended exception.
created: 2026-09-09T13:37:47Z
context_manifest: sha256:01522b9d29ec13a0f634dae96b9e723164a4aabffa9be7af3fe3d3d13f8e48d1
schema: 1
---
# Spec: Cybercab step 6 — finish Pipeline, Gates, Loop, Security and Metrics to the handoff

The specification is `sdlc/changes/CHG-0001/design/README.md` (the step 6 handoff) and its reference file `SDLC Console (Cybercab step 6).dc.html`. This spec turns the handoff into checkable requirements, records for every handoff line whether the code on `main` (after PRs #30 and #31) already satisfies it, and names the files, tests and done signals the plan must carry. Seed data and literal hex in the mock are not requirements; `var(--*)` tokens and the real `Snapshot` are.

## Requirements

R1. **Headline per view.** Each of Pipeline, Gates, Loop, Security and Metrics opens with one 22px sentence (`.primary`) for the current role:
- Pipeline: `{n} decisions wait on the {role}.` (`1 decision waits on …`), else `Nothing waits on the {role}.`; sub-line mono 12 `--text-faint`: `{k} changes in flight · {a} agents working · {o} waiting on {other roles}`.
- Gates: `{n} decisions wait on the {role}.`, else `Queue clear — nothing waits on the {role}.`
- Loop: `{n} signals in the triage queue.` (`1 signal …`), else `Queue clear — the loop is feeding itself.`
- Security: `{n} findings need a route.` (`1 finding …`), else `No new findings.`; sub-line mono 12 `{source} · {repos} repo(s) · last run {ts} · {scan link} · {validated} validated`, or the existing "scanner not connected" text unchanged.
- Metrics: `Metrics`; sub-line mono 12, flex-wrap: `30-day window vs the 30 before` then one word pair per feed `{label} · {via}` (amber when `via === "none"`).
`{role}` is `ROLE_LABEL[role]`; `{other roles}` is `the engineer or tech lead` for po and `the product owner or tech lead` for eng (mock line 235). `n` on Pipeline and Gates is the same number: cards whose open gate (artifact gate or production gate) is owned by `role`.

R2. **Pipeline** keeps six stage columns in a `repeat(6, minmax(0,1fr))` grid, gap 24, with no minimum width, no column background, border, radius or padding. A column is: top hairline; mono 12 head row `{num} {Name}` in `--text-secondary` with the count right-aligned in `--text-faint`; artifact caption mono 12 `--text-faint` (`intent.md`, `spec.md`, `plan.md`, `evals`, `PR + findings`, `incident → intent.md`), margin-bottom 16. An empty column has no cards and no "Nothing here" text; the count reads 0.

R3. **Pipeline card** is an `.edge-lit` button, no border or radius, padding `12px 14px 12px 16px`, margin-bottom 8, background `--bg-panel` only when its gate is owned by `role`, else transparent; hover `--bg-raised`. Edge: `amber` with glow when owned by `role`; `off` (`--text-faintest`, no glow) when the gate is owned by another role; `agent pulse` when `c.agent`; `off` otherwise. An open production gate counts as a gate whose owners are `productionGate.ownerRoles`. Lines:
- Line 1 mono 12 `--text-faint`: `{id}`, then ` · high risk` in `--amber` when `risk === "high"`, then ` · invalid` in `--red` when `!valid`. No agent word (C6).
- Line 2: title, `--text-primary`, weight 500, line-height 1.35.
- Line 3 mono 12: gate → `{gate.label} · {owner label, lowercase} · waiting {rel}` in `--amber` when owned else `--text-faint`; production gate → `Deploy to {env} · {owner roles, lowercase} · rehearsal pending` or `· waiting {rel}`; otherwise `c.status`. For stage ≥ 5 (or any deployed environment) the same line continues with ` · {glyph} {env}` per environment, glyph in its state colour (`✓` green, `✗` red, `·` faint; running amber).
The owner label is the role's lowercase name (`product owner`, `engineer`, `tech lead`), never `TECH LEAD`/`PO`/`ENG`.

R4. **Gates** renders the headline (R1), then the rows owned by `role`: grid `110px minmax(0,1fr) auto`, gap 20, top hairline, padding `14px 0 14px 16px`, `.edge-lit.amber`, hover `--bg-panel`; col 1 id mono `--text-muted`; col 2 gate label (`--text-primary`, 500) over `{title} · {stage name}` (`--text-muted`), with ` · rollback rehearsal pending` kept for a blocked production gate; col 3 `waiting {rel}` mono `--text-faint`. Then, margin-top 40, a mono 12 eyebrow `Waiting on {other roles} · {n}` and the other roles' rows: same grid, padding 12, edge `off`, all text `--text-muted`, one line `{label} · {title}`. No `Yours ·` heading, no `Other role` heading, no "Nothing here"; the whole row is the button.

R5. **Loop** renders the headline (R1), the triage queue, then Bands. Triage item: `--bg-panel` plane, `.edge-lit` (`amber` for σ tiers, `red` for `incident`), padding `20px 24px 20px 28px`, 2px between items. Meta row mono 12 `--text-faint`: id (`--text-muted`) · tier word in the edge colour · `src` · job kind/state and session words · channel author + `message` link · time right-aligned. Title 22px weight 500. Evidence `<pre>` mono 12, line-height 1.6, `--text-muted`, no border or background, margin-top 12, max-height 220 with scroll, content verbatim (C8). Runbook runs as one mono line. Actions: `.btn.primary` `Accept → Plan`, `.btn.text` `Dismiss · tune band` opening the existing `InlineReason` (reason required, tune optional), form max-width 560.

R6. **Bands** follow the queue at margin-top 48: section head mono 12 `Bands · rolling {window} · Western Electric · detection every {n} · last {ts}` with a spacer and `.btn.text` `Run detection` when `onDetect` is set. Rows are a grid `180px 110px 110px 60px 50px minmax(0,1fr)`, gap 16, padding 10px 0, top hairline, mono 12: metric `--text-secondary` · baseline `--text-muted` · current (`--amber` when breached, `--text-secondary` otherwise, `--text-faint` for the no-data texts) · `{σ}σ` `--text-faint` · tier word (`--amber` ≥ 2σ, `--text-faint` below, `—` when null) · status text plus the open triage ids (amber words) and the live job (`{kind} {state} · {session}`) as words. Footer mono line: `1σ log · 2σ diagnose read-only · 3σ propose via PR or runbook {runbook ids}`. No `<table>`, no header background, no row tint, no Action column (tier actions are fixed by schema and named in the footer line).

R7. **Security** renders the headline and sub-line (R1), then finding rows with a 2px gap, `.edge-lit`: `red` high, `amber` medium, `off` low; the glow shows only while `status === "new"` (C9). The **first finding with `status === "new"` and no `resolved`** carries class `primary-row`: `--bg-panel` background, padding `20px 24px`, title 22px weight 500. Every other row: transparent, padding `14px 24px`, title 14px weight 500. Dismissed or resolved rows: opacity .6. Meta mono 12 `--text-faint`: severity word in its colour · id (`--text-muted`) · `validated · {conf}` (or `{conf}`) · status word right-aligned (`new`, `patch in PR gate`, `escalated → intent {CHG}`, `dismissed`, `resolved by scanner · {at}`). Title (link when `f.url`), description `--text-muted`, then one mono `--text-faint` line with location, rule, CWE, run link and source, then the evidence `<pre>` as in R5. Actions while new and unresolved: `.btn.primary` `Patch → PR gate`, `.btn.text` `Wider than one patch → intent.md`, `.btn.text` `Dismiss with reason` → existing `InlineReason`. Footer: one mono 12 line `fixes reach production only through the PR gate · the proposing agent cannot approve its own fix`.

R8. **Metrics** renders the headline and sub-line (R1), then a grid `repeat(3, minmax(0,1fr))`, gap `40px 48px`, max-width 1200, one cell per stage: head mono 12 `{num} {Name}` with a bottom hairline, then one block per metric, leading first then lagging, no `Leading`/`Lagging` sub-headers, no panel background or padding. Block: value row = value 22px weight 500 tabular · trend mono 12 · kind word (`leading`/`lagging`) right-aligned mono `--text-faintest`; name `--text-secondary`; then mono 12 `--text-faint` `{note} · {sources}`. Trend: `▲ {+delta%}` or `▼ {delta%}` in `--green` when `trend === better` and `--amber` otherwise, glyph alone when `delta` is null, `—` in `--text-faint` when `trend` is null or `flat`; the span keeps class `trend` and `title={fmtPrev(v)}` (C10). The per-panel `30 days` caption is gone.

R9. **tokens.css** loses, after the views no longer reference them: `.pipeline` min-width and the `minmax(200px, …)` columns, `.column`, `.column-head`, `.column-num`, `.column-count`, `.column-caption`, `.card*`, `.env-strip`, `.gates h2`, `.row`, `.row .label/.meta/.since`, `.bands` table rules including `th` and `tr.breached/.warned`, `.footer`, `.halves`, `.half`, `.stage-plane`, `.metrics` two-column grid, `.metrics-sources`, `.metric-*` sizes other than 12/14/22, the `.item .evidence` background and padding, and the comment on line 105 that mentions chips. The `.chip*` rules named by the handoff do not exist on `main`; the remaining `chip` hits are the `--radius-chip` token (C2), that comment, and `record.chip` in `lib/format.ts` (C1). `.empty` and `.section-head` stay: Config, Sessions and ChangeDetail use them. `.inline-reason .row` is a different selector and stays.

R10. **Snapshot strings and tests.** `packages/web/test/render.test.tsx` no longer asserts `⌁ agent`/`agent-text pulse`, `routine`, `Leading`/`Lagging`, `class="half"`, `Triage queue`, `Yours · product owner`, `Yours · engineer`, `Other role`, `Nothing here`, `commits intent.md`, `TECH LEAD`, `class="card …`, `class="breached"`, `class="env-strip mono"`, `<span class="metric-sources">`, the old tier footer sentence, `rolling 30d baseline · Western Electric rules` or `detection every 15m · last snapshot never`; each is replaced by its handoff replacement in the same test (C4). Three tests are added: (1) the seed's Pipeline card with a gate owned by the rendered role has class `edge-lit amber` and the same card rendered for the other role has `edge-lit off`; (2) the Security view's first new finding is the only element with class `primary-row`; (3) a Loop dismiss opens an `InlineReason` whose submit is disabled while the reason is blank (`canSubmit` false) and enabled with a reason, with the tune field optional. The render test also asserts the Pipeline and Gates headline numbers agree for the seed (R1).

R11. **Done signals.** `pnpm build`, `pnpm test`, `pnpm lint` green; `grep -rnE '\.chip|"chip|chip[ "]' packages/web/src` returns nothing (C1/C2 decide whether the literal `grep chip` is also required); the render snapshots contain none of the R10 strings; the three R10 tests exist and pass; every removal is one commit whose message carries the removals-log line (C5).

R12. **Unchanged.** Routes, `Snapshot`, view callbacks (`onSelect`, `onAccept`, `onDismiss`, `onDetect`, `onPatch`, `onEscalate`, `onForm`), semantic colour values, fonts, `kilnpulse`; no new dependencies; no new utility classes beyond one scoped no-glow rule (C9); nothing outside `packages/web`.

## Design

The design is a rewrite of five view components and their component CSS, with no change to data, routes or callbacks. It has four parts: an audit of where `main` stands against each handoff line, the component and prop changes, the CSS rewrite, and the commit order and file list the plan inherits.

### Where `main` stands against the handoff
Verified against `packages/web/src` at `35023ee`. "Done" means PR #31 already satisfies the line; "open" is work for this change.

| View | Handoff line | State |
|---|---|---|
| Pipeline | headline + sub-line for the role | open — no headline; `Pipeline` has no `role` prop (`Pipeline.tsx:4-8`) |
| Pipeline | grid without 1280px min-width, column chrome | open — `tokens.css:134-139` |
| Pipeline | card = `.edge-lit` button, panel bg only when owned | open — `.card` has `--bg-raised` + radius (`tokens.css:141`); edge is amber for any gate, red for invalid (`Pipeline.tsx:31`) |
| Pipeline | line 1 words, no agent word | open — `agent-text pulse` span (`Pipeline.tsx:37`) |
| Pipeline | line 3 = gate line or status, owner lowercase, env words | open — status and gate line are two lines; owner via `gateOwnerLabel` is upper-case; `.env-strip` (`Pipeline.tsx:49`) |
| Pipeline | `.chip agent ⌁`, `.chip amber/red`, `.gate-strip` | done in #31 |
| Pipeline | `"Nothing here"` empty | open (`Pipeline.tsx:28`) |
| Pipeline | caption `intent.md … incident → intent.md` | open — reads `commits {artifact}` |
| Gates | headline | open — `h2.section-head "Yours · …"` (`Gates.tsx:28`) |
| Gates | row grid 110/gap 20/hairline/edge-lit amber | open — `82px`, gap 14, border-bottom (`tokens.css:206`) |
| Gates | other section eyebrow, single-line rows, colour not opacity | open — same two-line rows, `Other role` heading; no opacity rule exists (done) |
| Gates | `.dot`, `→` arrow, `h2.yours` uppercase | done in #31 |
| Loop | triage first, bands second | open — table first (`Loop.tsx:41-75`) |
| Loop | headline | open — `h1 Loop` + `Triage queue` section head |
| Loop | triage item anatomy | mostly done — `.item` plane, edge, meta, actions; open: title size 22px, evidence without background, time right-aligned, form max-width |
| Loop | bands as hairline grid, section head, footer mono line | open — `<table class=bands>` with `th`, `tr.breached/.warned`, `.footer` paragraph |
| Loop | `.chip` tier/triage/job, `.tcard` | done in #31 |
| Security | headline + sub-line | open — `h1 Security` + `view-head` |
| Security | first new finding = primary object (`primary-row`) | open — every `.item` is a panel (`tokens.css:232`) |
| Security | glow only while new; low = `off` | open — `off` for low and for dismissed; glow for every lit edge |
| Security | footer one mono line | open — three-clause sentence (`Security.tsx:73`) |
| Security | severity/source/status chips, `.tcard`, `.subhead` | done in #31 |
| Metrics | headline + sub-line with feeds | open — feeds are a separate `metrics-sources` row |
| Metrics | 3-column grid, no panel, stacked metrics with kind word | open — `.stage-plane`, `.halves`, `Half` with `Leading/Lagging` eyebrow (`Metrics.tsx:30-43, 75-78`) |
| Metrics | value 22px · trend · kind on one row | open — value is its own line |
| Metrics | trend as `▲ +9%` | open — `Trend` renders `up +9%` words |
| Metrics | `TrendChip .chip` → word, keep `title=fmtPrev` | done in #31 (`Trend`, `title={fmtPrev(v)}`) |
| Metrics | `"30 days"` caption, orange numeral | open — `column-count` "30 days"; numeral is `--text-muted` (done) |
| tokens.css | deletions list | open — see R9 |

### Components and props
- `Pipeline` gains `role: Role` (from `UIState.role`); `app.tsx:197` passes `state.role` (C3). Ownership: `ownsGate(c, role)` or `c.deploy.productionGate?.open && ownerRoles.includes(role)`. `n`, `k` (rendered cards), `a` (`c.agent`), `o` (gate owned by another role) are computed in the view from `changes`; no core or server change.
- `Gates` keeps its props; the headline count is `queues.yours.length` filtered to rows with an open gate, the same predicate the rows use.
- `Loop`, `Security`, `Metrics` keep their props. `Loop` reorders its JSX and replaces the table with `div` rows. `Security` computes `primaryId = findings.find(f => f.status === "new" && !f.resolved)?.id` and adds `primary-row` and `new` classes. `Metrics` drops `Half`, renders `[...s.leading, ...s.lagging]` with a `kind` word, and `Trend` maps `up`/`down` to `▲`/`▼`.
- Ownership words come from a lowercase owner label: `view.gate.ownerLabel` (core already provides `ownerLabel`; `ROLE_LABELS` in `derive.ts:287`), so `gateOwnerLabel` in `lib/format.ts` is no longer used by Pipeline. Leaving it in place keeps `lib/format.ts` out of the diff; lint decides (an unused export does not fail `pnpm lint`).
- `InlineReason` is untouched; the dismiss forms keep `fields` with `reason` required and `tune` optional.

### CSS
Component rules are rewritten under new names so the removals are visible as deletions: `.pipeline` (grid), `.pcol`, `.pcol-head`, `.pcol-caption`, `.pcard` (+ `.edge-lit`), `.pline`; `.gates`, `.grow` (yours) and `.grow.other`; `.triage-item` reuses `.item`; `.bands-head`, `.band-row`, `.bands-foot`; `.security .item.primary-row`, `.security .item:not(.new)::before { box-shadow: none }`; `.metrics` 3-column grid, `.mstage`, `.mrow`, `.mkind`. Sizes come only from `--text-data` (12), body (14) and `--text-primary-size` (22). `--radius-chip` is kept unless C2 resolves otherwise. Every colour is a `var(--*)`; no hex is added.

### Commits and the plan
- One commit per removals-log line, message `sdlc(web): <line>` (C5), in this order: Pipeline (grid, card, line 1, line 3, empty), Gates (headline, rows, other), Loop (order, headline, item, bands, footer), Security (headline, primary row, glow, footer), Metrics (sub-line, grid, value row, trend, caption), then `tokens.css` deletions and the `render.test.tsx` update, then the three new tests. Test updates ride with the removal that changes the string they assert, so `pnpm test` is green at every commit.
- Files that change (8, under `thresholds.autoFilesMax: 12`; coverage is lenient and CLAUDE.md has a test target, so the build session is AUTO-eligible): `packages/web/src/views/Pipeline.tsx`, `Gates.tsx`, `Loop.tsx`, `Security.tsx`, `Metrics.tsx`, `packages/web/src/tokens.css`, `packages/web/src/app.tsx`, `packages/web/test/render.test.tsx`.
- Proof: `pnpm build`, `pnpm test`, `pnpm lint` output verbatim; the grep from R11 with empty output; the three new tests named in the round.

### Out of scope
Merging Loop and Security into one view (handoff defers it); any change to `ChangeDetail`, `Sessions`, `Config`, `TopBar`; core, server, schemas; `docs/decisions.md` unless C7 says otherwise.

## Areas of concern
Each concern is carried in the front-matter as `{id, policy, owner, resolved: false}`; none is resolved here.

- **C1 · `grep chip` done signal vs the Snapshot contract** — policy: intent.md Constraints ("the Snapshot data contract … stay as they are") and decisions.md principle 12. Owner: po. `lib/format.ts:86` reads `record.chip`, a core field; the literal grep cannot be empty without renaming it outside `packages/web`. Proposed reading in R11.
- **C2 · `--radius-chip` token** — policy: decisions.md 1.2 (tokens.css carries every §6 token). Owner: tech_lead. Deleting the token empties the grep; keeping it honours 1.2. Decide with C1.
- **C3 · `app.tsx` is a changed file** — policy: plan-sync hook (FR-41). Owner: eng. The intent's file list omits it; plan.md must include it.
- **C4 · rewriting snapshot assertions** — policy: CLAUDE.md "never skip or delete a failing test; fix the code, not the test". Owner: eng. This change replaces assertions on removed strings by design; the rule in R10 keeps every `it` and adds three.
- **C5 · commit message format** — policy: CLAUDE.md Conventions vs handoff "message = the removals-log line". Owner: eng. Proposed `sdlc(web): <line>`.
- **C6 · state moved from word to colour** — policy: playbook "demoted, never hidden"; Cybercab rule 6. Owner: po. Agent word leaves line 1; invalid loses its red edge; other-role gates go faint. Line 3 keeps the words.
- **C7 · decisions.md rows 3.4 and 3.6 describe the old rendering** — policy: decisions.md preamble. Owner: tech_lead. Amend in this change or separately.
- **C8 · evidence `<pre>` styling** — policy: CLAUDE.md non-negotiable "evidence shown verbatim, never summarised". Owner: eng. Background and padding go; content, wrapping and scroll stay.
- **C9 · one scoped no-glow rule** — policy: intent constraint "same utilities as the previous step". Owner: eng. A scoped selector, not a new utility.
- **C10 · trend glyphs** — policy: Cybercab rule 6; decisions.md 1.3/2.10 (trend as a word). Owner: po. The handoff and mock use `▲`/`▼`; spec follows the handoff.

## Open questions carried forward
- From intent: whether merging the Loop and Security queues into one view follows this step. The handoff defers the IA decision; this spec keeps two views with one row anatomy.
- From intent: whether `design/` should hold the handoff so the design session reads it from git. It now does (`sdlc/changes/CHG-0001/design/`, commit `ff37c8c`); the question left is whether the previous bundle (`design_handoff_cybercab_redesign/`, referenced by the handoff for tokens and `InlineReason`) should also be committed, since nothing in git holds it.
- Whether the literal `grep chip packages/web/src` stays the done signal or becomes the selector-only grep in R11 (C1, C2).
- Whether the decisions.md amendment for rows 3.4 and 3.6 rides in this change (C7).

# Handoff: SDLC Console — Cybercab step 6 (Pipeline · Gates · Loop · Security · Metrics)

Continues `design_handoff_cybercab_redesign/README.md`. Same tokens, same utilities (`.edge-lit`, `.bar-lit`, `.hairline`, `.btn.text`, `.btn.primary`, `InlineReason`), same constraints: routes, data contracts and callbacks unchanged; semantic colour values unchanged; one commit per removal, message = the removals-log line; no new dependencies.

## About the design file
`SDLC Console (Cybercab step 6).dc.html` is a **design reference in HTML**, not code to ship. Recreate it in `packages/web/src/views/{Pipeline,Gates,Loop,Security,Metrics}.tsx` + `tokens.css`. The mock uses seed data and literal hex; use the `var(--*)` names and the real `Snapshot`.

## Playbook check
The redesign was checked against *The AI-Native SDLC playbook* (claude.com/blog/the-ai-native-sdlc-playbook). It reinforces the playbook rather than conflicting with it; the places where a Cybercab rule would have cut something the playbook requires are called out as **usability exceptions**:

- Human attention "concentrates at the gates" → rule 2 (one primary object = the decision) is the playbook's own emphasis. Every view leads with the decision count for the current role.
- Every artifact and decision is an audit record → nothing that is evidence (test output, PR checks, review findings, hook blocks, dismissal reasons) is removed; it is demoted in weight, never hidden behind hover. **Exception to rule 3:** evidence rows and `<pre>` output stay visible, not hover-revealed.
- Dismissals must carry a reason and be recorded → every dismiss is an `InlineReason` with a required reason; band-tune stays optional as before.
- Separation of duties / agent cannot approve its own fix → the Security footer sentence is kept (shortened) because it states the control, not decoration. **Exception to rule 1.**
- Hooks "block should explain itself" → blocked states (`recordBlock`, `production.blocked`, "rollback rehearsal pending") render as amber text lines, never removed. **Exception to rule 3's quiet empty states.**
- Skills are advisory unless hook-backed → Config already shows "backed by"; unchanged.
- Loop tiers (1σ log · 2σ diagnose · 3σ propose via PR/runbook) → kept as one mono line under Bands.
- Scan findings handled "the way a breached control band is" → Loop and Security get the identical row anatomy (id · tier/severity · source · title at 22px · evidence · Accept/Patch primary · Dismiss with reason) so the two queues read as one pattern. Merging them into one view is a later IA decision, not in this step.
- The playbook describes a loop, not a line → Pipeline keeps six stage columns (the data model is stage-indexed) but the Maintain column's caption reads `incident → intent.md` to name the loop-back.

---

## Pipeline (`Pipeline.tsx`) — the landing view
- Headline 22px: `{n} decisions wait on the {role}.` / `Nothing waits on the {role}.` Sub-line mono 12 `--text-faint`: `{k} changes in flight · {a} agents working · {o} waiting on {other role(s)}`. Needs `role` and `now` props (add `role: Role` — it is in `UIState`).
- Grid: 6 columns `repeat(6, minmax(0,1fr))`, gap 24. **Remove `min-width: 1280px`, column background, border, radius, padding** — a column is: 1px top hairline, then mono 12 head row (`{num} {Name}` in `--text-secondary`, count right-aligned `--text-faint`), then artifact caption mono 12 `--text-faint` (`intent.md` … `incident → intent.md`), margin-bottom 16.
- **Card** → `.edge-lit` button, no border/radius, padding `12px 14px 12px 16px`, margin-bottom 8. Background `--bg-panel` only when the gate is owned by the current role, else transparent; hover `--bg-raised`.
  - Edge: `--amber` + glow when owned; `--text-faintest` (no glow) when gate owned by another role; `--agent .pulse` when `c.agent`; `--text-faintest` otherwise. Production gate open counts as a gate (owner = `productionGate.ownerRoles`).
  - Line 1 mono 12 `--text-faint`: `{id}` + ` · high risk` in `--amber` when `risk === "high"` + ` · invalid` in `--red` when `!valid`.
  - Line 2: title, `--text-primary`, weight 500, line-height 1.35.
  - Line 3 mono 12: when a gate → `{gate.label} · {owner label lowercase} · waiting {rel}` in `--amber` if owned else `--text-faint`; production gate → `Deploy to {env} · {owners} · rehearsal pending|waiting {rel}`; else `c.status`. Environments (stage ≥ 5) append ` · staging ✓ · production ·` as glyph+name words in the same line, glyphs in state colours.
- Removals: `.chip agent ⌁`, `.chip amber`, `.chip red` → words in line 1/edge; `.gate-strip` → edge + line 3; `.env-strip` → words in line 3; `"Nothing here"` empty → column simply has no cards (the count reads 0).

## Gates (`Gates.tsx`)
- Headline 22px: `{n} decisions wait on the {role}.` / `Queue clear — nothing waits on the {role}.`
- **Yours** rows: grid `110px minmax(0,1fr) auto`, gap 20, top hairline, padding `14px 0 14px 16px`, `.edge-lit.amber`. Col 1 id mono `--text-muted`; col 2 gate label (`--text-primary` 500) over `{title} · {stage}` (`--text-muted`); col 3 `waiting {rel}` mono `--text-faint`. Hover `--bg-panel`.
- **Other** section: mono 12 eyebrow `Waiting on {other role(s)} · {n}`, margin-top 40. Rows same grid, padding 12, edge `--text-faintest` no glow, all text `--text-muted`, single line `{label} · {title}`.
- Removals: `h2.yours` uppercase heading → headline; `.dot` → edge; `→` arrow → none (whole row is the button); `.row` border/radius/background → hairline + hover; `opacity: .65` on other → colour, not opacity.

## Loop (`Loop.tsx`) — triage first, bands second
- Headline 22px: `{n} signals in the triage queue.` / `Queue clear — the loop is feeding itself.`
- **Triage item** (primary object): `--bg-panel` plane, `.edge-lit` (`--amber` for σ tiers, `--red` for `incident`), padding `20px 24px 20px 28px`, gap 2 between. Meta row mono 12 `--text-faint`: id (`--text-muted`) · tier word in edge colour · `src` · job/session words · channel author + `message` link · time right. Title **22px weight 500**. Evidence `<pre>` mono 12/1.6 `--text-muted`, no border/background, margin-top 12, max-height 220 scroll. Runbook runs as a mono line. Actions: `.btn.primary` "Accept → Plan" + `.btn.text` "Dismiss · tune band" → existing `InlineReason` (reason required, tune optional), max-width 560.
- **Bands** after the queue, margin-top 48: section head mono 12 (`Bands` · `rolling {window} · Western Electric · detection every {n} · last {ts}` · spacer · `.btn.text` Run detection when `onDetect`). Rows grid `180px 110px 110px 60px 50px minmax(0,1fr)`, gap 16, padding 10/0, hairline, mono 12: metric `--text-secondary` · baseline `--text-muted` · current (`--amber` when breached, `--text-secondary` otherwise, `--text-faint` "no data") · `{σ}σ` `--text-faint` · tier word coloured (`--amber` ≥ 2σ, `--text-faint` else, `—` when null) · status + triage ids + live job as words. Footer mono line `1σ log · 2σ diagnose read-only · 3σ propose via PR or runbook {ids}`.
- Removals: `<table>` header backgrounds → hairline grid; `.chip amber` tier/triage/job chips → coloured words; `tr.breached/warned` row tint → current-value colour; `.tcard` border/radius; `.footer` paragraph → section head + one mono line; `h2.eyebrow "Triage queue · N"` → headline.

## Security (`Security.tsx`)
- Headline 22px: `{n} findings need a route.` / `No new findings.` Sub-line mono 12: `{source} · {repos} repo · last run {ts} · {scan link} · {validated} validated` (or the "scanner not connected" text, unchanged).
- **Finding rows**, gap 2, `.edge-lit`: edge `--red` high · `--amber` medium · `--text-faintest` low; glow only while `status === "new"`. The **first new finding** is the primary object: `--bg-panel` background, padding 20/24, title 22px. Others: transparent, padding 14/24, title 14px 500. Dismissed/resolved: opacity .6 (kept — it's status, not decoration).
  - Meta mono 12 `--text-faint`: severity word in its colour · id (`--text-muted`) · `validated · {conf}` · status word (`patch in PR gate`, `escalated → intent`, `resolved by scanner · {at}`) right-aligned.
  - Title (link when `f.url`), desc `--text-muted`, location/rule/CWE/run mono `--text-faint`, evidence `<pre>` as in Loop.
  - Actions (new & unresolved): `.btn.primary` "Patch → PR gate", `.btn.text` "Wider than one patch → intent.md", `.btn.text` "Dismiss with reason" → existing `InlineReason`.
- Footer → one mono 12 line: `fixes reach production only through the PR gate · the proposing agent cannot approve its own fix` (kept: states a control).
- Removals: severity/source/status `.chip`s → words; `.tcard` border/radius; `.subhead` → headline + sub-line.

## Metrics (`Metrics.tsx`)
- Headline 22px `Metrics`; sub-line mono 12 flex-wrap: `30-day window vs the 30 before` · each source as `{label} · {via}` (amber when `via === "none"`).
- Grid `repeat(3, minmax(0,1fr))`, gap `40px 48px`, max-width 1200. Each stage: head mono 12 `{num} {Name}` with bottom hairline; then one block per metric (leading first, then lagging — the Leading/Lagging sub-headers are removed; a `kind` word sits right-aligned in `--text-faintest` mono 10→12 on the value row).
  - Value row: value **22px 500 tabular** · trend mono 12 (`▲ +9%` `--green` when `trend === better`, `--amber` otherwise, `—` `--text-faint`) · kind word right.
  - Name `--text-secondary`; note + sources mono 12 `--text-faint` as `{note} · {sources}`.
- Removals: `.panel` border/radius/padding; `.halves` two-column split → stacked; `TrendChip` `.chip` → coloured mono word (keep `title={fmtPrev(v)}`); `"30 days"` per-panel caption → once in the sub-line; `.column-head` orange numeral → mono grey.

## tokens.css deletions after this step
`.pipeline` min-width, `.column*`, `.card*`, `.chip*`, `.gate-strip`, `.env-strip`, `.dot`, `.owner`, `.gates h2`, `.row*`, `.bands th` backgrounds, `tr.breached/.warned`, `.tcard*`, `.footer`, `.subhead`, `.metrics-sources .chip`, `.halves`, `.metric-*` sizes other than 12/14/22. Grep for `chip` afterwards — zero hits is the done signal.

## Tests
`render.test.tsx` snapshots drop: `⌁ agent`, `routine`, `Leading`/`Lagging`, `Triage queue ·`, `Yours · product owner`, `Other role`, chip texts. Confirm each against this log. Add: Pipeline card with owned gate has class `edge-lit amber`; Security first-new finding has `.primary-row`; Loop dismiss requires reason.

## Files
- `SDLC Console (Cybercab step 6).dc.html` + `support.js` — reference (switch role; open a dismiss form).
- Previous bundle (`design_handoff_cybercab_redesign/`) for tokens, utilities, `InlineReason`.

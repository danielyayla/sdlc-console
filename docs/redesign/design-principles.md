# Design principles — the Cybercab pass on `packages/web`

Seven rules, restated for this console, each with one before/after drawn from the views as they were before PR #30. The tokens are in `packages/web/src/tokens.css`; the semantic colour values (amber, green, red, orange-as-agent) are constraints and did not change. The "before" column names what was removed; the removals log at the end maps each removal to its commit so a load-bearing one is a single `git revert`.

## 1 · Remove the steering wheel
Every control that existed because an earlier version had it, not because the user decides with it, goes. The user is a passenger who makes decisions, not an operator who steers.

- **Before:** the change header carried a stage chip, a "routine" risk chip, a cycle chip and an Export chip; Sessions opened with an always-visible composer and closed with an explanatory paragraph.
- **After:** the stage bar directly below already names the stage; only "high risk" is information; the cycle shows only when it is greater than 1; Export is a text link at the end of History. "New session" opens the composer when asked; the paragraph belongs in `docs/`.

## 2 · One center screen
Every view has exactly one primary object, rendered at the one primary size (22px). Everything else is body or data weight. No view presents two things of equal weight.

- **Before:** the change's right rail stacked nine panels (Records, Repro, PR, Production gate, Environments, Eval suite, Validation, Auto mode, Sessions) beside the gate panel; Config opened on a four-chip banner and a Repeat-mistakes section beside Proposals; every session card was the same size.
- **After:** the rail is three sections, Decision · Evidence · History, and the Decision is the only rail section at 22px (an open production gate *is* the decision). Config leads with the open proposal at 22px; the banner is a status line of four figures. Sessions has one primary row: the one waiting on you, else the running one, else the newest.
- **Usability exception:** each view keeps its title at 22px as the identity line (the change title, "Sessions", "Config"), and the four Config figures share the size as tabular data. They read as context, not as a second decision, because only the Decision, the primary row and the open proposal carry a lit edge and the accent button.

## 3 · Doors with no handles
Affordances appear on selection, hover or focus. Inline forms replace dialogs and prompts. Empty states are quiet.

- **Before:** every session row showed Stop / Take over / Downgrade / Add guidance; eleven `window.prompt()` calls asked for reasons in a browser dialog; empties said "Nothing here" in a bordered box.
- **After:** actions appear when the row is selected; every reason is an `InlineReason` form under the row it belongs to, with the submit dim until the required field is filled; an empty section is one faintest mono word.
- **Usability exceptions:** a row that is waiting on you shows its actions without being selected; evidence rows and verbatim `<pre>` output stay visible, never hover-revealed; blocked states (`recordBlock`, `production.blocked`) render as amber lines, not hidden.

## 4 · Flat planes, hard geometry
Straight edges, radii of 0–2px, 1px hairlines, generous negative space. No shadows, no gradients, no pills. Surfaces separate by luminance.

- **Before:** panels had 1px borders and 10px radius, chips 4px, controls 6–8px; the toast cast a `0 12px 32px` shadow; tables had header backgrounds.
- **After:** `--radius-chip: 0`, `--radius-panel: 0`, `--radius-control: 2px`, `--radius-card: 2px`. Planes are `--bg-app #0a0a0b`, `--bg-panel #0f0f10`, `--bg-raised #141415`, `--bg-hover #1a1a1c` with no border between them; hairlines (`--border-subtle`) sit only between rows. The toast is a flat raised plane with a 2px accent line on top.

## 5 · Monochrome with one metallic accent
Near-black surfaces, six greys, one champagne accent for the single interactive element that matters. Semantic colours are state, never decoration.

- **Before:** kiln orange `#e8703a` was brand, ids, agent, primary buttons and the active tab at once.
- **After:** `--accent #d2b47c` (hover `#e3c994`, text `#0a0a0b`) is used for the one primary button, the active tab underline, a focused field's underline and the "New session" / "Switch role" text. Orange survives only as `--agent` (live agent work). `--amber`, `--green`, `--red` are unchanged.

## 6 · Ambient light strips
State is a thin line of light, not a filled badge. A pending gate is a lit edge.

- **Before:** cards carried an amber gate strip (dot + label + OWNER); the top bar showed amber pill badges; hook actions were red/amber/green chips; the stepper used coloured dots.
- **After:** a card, row or Decision is `.edge-lit` (2px edge, 10px glow; amber when the decision is yours, orange pulsing when an agent works, unlit when neither); the stepper is six `.bar-lit` lines; the eval run history is `.bar-lit` segments; tab counts are amber mono numerals; hook actions are words in their state colour.

## 7 · Built for two seats
Narrow scope, three type sizes, one mono face for data and one sans for everything else, geometric glyphs only where a word would be longer.

- **Before:** mono from 9.5 to 12px, body 13/14px, uppercase `.08em` eyebrows, ⌁ and ● glyphs, "→" arrows on gate rows.
- **After:** `--text-data 12px` (JetBrains Mono), `--text-body 14px` and `--text-primary-size 22px` (Source Sans 3). Eyebrows are lowercase mono. The only glyphs are ✓ ✗ ! · in state colours and the 6px actor dot in History; the gate row is the button, so the arrow is gone.

## Removals log
One commit per line, subject = the line, on `redesign/cybercab` (PR #30) and `redesign/cybercab-sweep` (PR #31).

| Commit | Removal |
|---|---|
| c92ade7 | stage chip in header — the stage bar directly below already names the current stage |
| 5a58f37 | "routine" risk chip — routine is the default; only "high risk" is information |
| 6ec36a8 | cycle chip unless cycle > 1 — unchanged behaviour, stated explicitly |
| 323965c | Export chip from header → text link at the end of History; same href and download |
| 00aaf0b | viewer-head chips (record / write-back / PR) → merged as rows in Evidence |
| ad0b51b | separate panels Records, Repro, PR, Production gate, Environments, Eval suite, Validation, Auto mode, Sessions → rows in Evidence or History; actions stay attached to their rows |
| 99d7523 | production gate, when open, renders in Decision instead of a fourth panel |
| ee312c0 | "← Pipeline" button → breadcrumb text in the header row; same dispatch |
| 2f3bfbb | Sessions footer paragraph — documentation, not a control; belongs in docs/ |
| 1262b9e | mode chips, task chips, trace chip, subagent chips → words in the status line; trace stays a text link |
| 570e23c | always-visible composer → "New session" opens the inline form; same `onStart` payload |
| d3c40b8 | Jobs table header backgrounds and chips → hairline rows behind a "Jobs · N" disclosure |
| f474757 | action buttons from unselected rows — they appear when selected (exception: a row waiting on you shows them immediately) |
| f34cfa0 | Config banner with four chips → one status line of four figures; same data |
| 5183646 | Harness table when the only harness is claude-code with nothing degraded → one sentence; the table returns if any guarantee is degraded |
| ab03b1d | Subagents section → rows under Skills & subagents |
| 0e95583 | Repeat-mistakes section → the "seen N×" figure on each proposal; a signal without a proposal renders as a proposal-shaped row |
| 350f501 | table header backgrounds and status chips → hairline rows with words in state colours |
| d376579 | eval filter tabs → text toggles; same `statusFilter` state |
| e315728 … f8c3c8b | sweep of Pipeline, Gates, Loop, Security, Metrics to the same rules (PR #31) |

`f3c183b` replaced every `window.prompt()` with `InlineReason`; `647131e` introduced the tokens; `ee6bd1a` flipped `--accent` to champagne last so the pass could ship orange until every view was ready.

---
id: CHG-0001
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-09T13:18:07Z
status: draft
schema: 1
---
# Intent: Cybercab step 6 — finish Pipeline, Gates, Loop, Security and Metrics to the handoff

## Problem
The Cybercab redesign landed in two passes (PRs #30 and #31) without a written target: the second pass swept chips, strips and card chrome out of the five remaining views, but the handoff that defines step 6 (`design_handoff_cybercab_step6/README.md`) was never the artifact the work was checked against. Today the views still differ from it in the parts that carry the design's argument: no view leads with the decision sentence for the current role, the Pipeline keeps its 1280px minimum width and column chrome, the triage item and the first new security finding are not yet the single primary object of their views, Metrics still splits leading and lagging into halves, and `tokens.css` keeps the rules the step says to delete. Nobody can say from the code which of the handoff's lines are done.

## Proposed outcome
The five views match the step 6 handoff line for line, and the done signals it names hold: `grep chip packages/web/src` returns nothing, the render snapshots no longer contain the removed strings, and the three named tests exist (owned Pipeline card has `edge-lit amber`, the first new finding has `.primary-row`, a Loop dismiss requires a reason). Each view opens with its headline sentence for the current role; every removal is one commit whose message is the handoff's removals-log line.

## Affected users and systems
- Product owners and engineers reading the console: Pipeline (landing), Gates, Loop, Security, Metrics.
- `packages/web/src/views/{Pipeline,Gates,Loop,Security,Metrics}.tsx`, `packages/web/src/tokens.css`, `packages/web/test/render.test.tsx`.
- Nothing outside `packages/web`: routes, the `Snapshot` data contract and the view callbacks stay as they are.

## Constraints
- The handoff and its reference file (`SDLC Console (Cybercab step 6).dc.html`) are the specification; the mock's seed data and literal hex are not: use the `var(--*)` tokens and the real `Snapshot`.
- Semantic colour values unchanged; no new dependencies; the same utilities as the previous step (`.edge-lit`, `.bar-lit`, `.hairline`, `.btn.text`, `.btn.primary`, `InlineReason`).
- The playbook exceptions in the handoff stand: evidence rows and `<pre>` output stay visible, blocked states render as amber text lines, the Security footer sentence is kept because it states a control, every dismiss carries a required reason.
- Pipeline keeps six stage columns; the Maintain caption reads `incident → intent.md`.

## Open questions
- Whether merging the Loop and Security queues into one view follows this step; the handoff defers that IA decision.
- Whether the `design/` copy of the handoff should live in this change's directory so the design session reads it from git rather than from an untracked folder.

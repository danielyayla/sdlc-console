---
id: CHG-0003
artifact: intent
cycle: 1
author: dkapper01@gmail.com
created: 2026-09-10T09:03:19Z
status: draft
schema: 1
---
# Intent: Cybercab design principles doc under docs/redesign

## Problem
The Cybercab redesign of `packages/web` shipped as PR #30 and PR #31, but the `docs/redesign/design-principles.md` the brief asked for never reached the repo: it lived in the handoff bundle that was deleted after the merge. The seven rules, the usability exceptions and the removals log (one commit per removal, so a load-bearing one is a single `git revert`) now exist only in PR descriptions.

## Proposed outcome
`docs/redesign/design-principles.md` is committed: the seven rules restated for this console, one before/after per rule drawn from the views before PR #30, the usability exceptions, and the removals log mapping each removal to its commit.

## Affected users and systems
- Anyone touching `packages/web`: the doc is the reference the views were built to.
- No code, schema, config or test changes.

## Constraints
- Documentation only; the console never reads `docs/`.
- Semantic colour values and the tokens are described as shipped, not changed.

## Open questions
- None.

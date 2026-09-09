---
id: CHG-0005
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Each transition returns {files, events, commitMessage} or diagnostics without touching I/O; applying a plan to a synthetic tree and re-deriving moves the change to the expected stage for accept 1→2→3, send-back, loop 6→1 (cycle 2, archive, INC draft), confirmTasks, confirmRepro; agents cannot call accept; build/test/lint green"
schema: 1
---
# Plan: Transitions as write-plans, build-order item 0.5 (from spec.md n/a)

## Files that change
packages/schemas/src/serialize.ts (new)
packages/schemas/src/config.ts
packages/schemas/src/index.ts
packages/schemas/json/config.schema.json
packages/core/src/index.ts
packages/core/src/derive.ts
packages/core/src/ids.ts (new)
packages/core/src/writeplan.ts (new)
packages/core/src/transitions/context.ts (new)
packages/core/src/transitions/create-change.ts (new)
packages/core/src/transitions/accept.ts (new)
packages/core/src/transitions/send-back.ts (new)
packages/core/src/transitions/loop.ts (new)
packages/core/src/transitions/tasks.ts (new)
packages/core/src/transitions/repro.ts (new)
packages/core/src/transitions/index.ts (new)
packages/core/test/helpers.ts
packages/core/test/derive.test.ts
packages/core/test/transitions.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. schemas: `stringifyYaml`, `stringifyFrontMatter`; config gains `codeHost: local|github` (default local).
2. core derive: high-risk gate 3 accepted by a `tech_lead` actor is valid in local mode; `pr.merge` required in github mode.
3. writeplan.ts: `WritePlan {changeId, files[{path, content|null}], events[{changeId, event}], commitMessage, trailers, actor}`; `applyWritePlan(tree, plan)` for tests and the filesystem adapter; `TransitionResult`.
4. context.ts: `{now, newId, actor(human), mergeSha?, knownIds?}`; helpers to build events with the next seq, check gate ownership against config identities, refuse non-human actors.
5. ids.ts: `nextChangeId`.
6. createChange (template from tree or built-in), accept (gates 1/2/3/5; 6 delegates to loop; plan.md front-matter frozen on 3; pr.yaml merged on 5 with ctx.mergeSha), sendBack (feedback required), loop (archive to cycles/<n>/, cycle+1, kind fix, intent seeded from incident, INC-<id>-<n> draft case), proposeTasks + mergeOverlaps + confirmTasks, confirmRepro.
7. Tests: apply each plan to a synthetic tree, re-derive, assert stage/gate/docs; refusal cases (wrong role, agent actor, gate closed, empty feedback, linked mode without record, high-risk in console for eng).
8. Decisions, tick 0.5, commit.

## Risks
- Archiving in `loop` is expressed as delete+create pairs; the git adapter must apply deletes before creates in one commit.
- `loop` seeds `intent.md` from `incident.md` by section mapping; unmapped sections fall back to placeholders.

## Proof
pnpm build, pnpm test (transitions.test.ts round-trips every transition through deriveChange), pnpm lint.

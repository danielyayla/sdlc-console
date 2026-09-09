# Initiation prompt for Claude Code

Open Claude Code in this folder, switch to plan mode (Shift+Tab), and paste:

---

Read CLAUDE.md, docs/decisions.md and docs/build-order.md.

We are building the SDLC Console described in docs/blueprint/. Start with item 0.1 in docs/build-order.md and only 0.1: the monorepo scaffold. Do not touch any later item.

Produce an implementation plan that names every file you will create, the order you will create them in, and the check that proves it works. Constraints from CLAUDE.md apply: pnpm workspaces, TypeScript strict, Vitest, root-level `pnpm build`, `pnpm test`, `pnpm lint`; packages `schemas`, `core`, `adapters/git`, `cli` as empty shells that build and have one passing placeholder test each; `packages/core` must have zero runtime dependencies and no I/O imports. Also commit a `.gitattributes` with `sdlc/**/log.jsonl merge=union` and create `fixtures/.gitkeep`.

Before finishing the plan, tell me: what could this scaffold get wrong that would be expensive to fix later, and what did you choose not to do.

When I accept the plan, save it as sdlc/changes/CHG-0001/plan.md using sdlc/templates/plan.md, implement it, run build/test/lint, paste the output, and stop. Do not start 0.2.

---

After 0.1 merges, repeat with the next item: "Take item 0.2 in docs/build-order.md…" and tick the box in build-order.md as part of each PR.

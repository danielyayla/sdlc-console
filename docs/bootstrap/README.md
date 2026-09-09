# Bootstrap archive

How this repository was built before it ran its own SDLC. Kept for history; nothing here is live lifecycle state.

- `INIT_PROMPT.md` — the prompt that started the first Claude Code plan session.
- `build-order.md` — the 39 numbered items (phases 0–3) worked one plan-mode session at a time, with the exit-run notes for each phase.
- `plans/CHG-NNNN.md` — the `plan.md` each item was built from (front-matter was never chained: no intents, specs or ledgers existed yet). `plans/CHG-NNNN.change.yaml` are the matching change records, created locally and never committed during the bootstrap.

On 2026-09-09 the bootstrap state was moved here and the repository was re-initialised with `sdlc init`, so that from then on the console runs its own lifecycle (`sdlc/`, `.claude/hooks`, `.github/workflows/sdlc-*.yml`). The product specification the bootstrap followed is still live: `docs/blueprint/`, `docs/decisions.md`, `docs/storage-layout.md`.

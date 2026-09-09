# SDLC Console

Single-screen console for an AI-native software delivery loop. Humans decide at gates; agents produce artifacts between them; git is the source of truth.

- `docs/decisions.md` — principles and resolved defaults (read first)
- `docs/storage-layout.md` — file layout, IDs, event shapes
- `docs/blueprint/` — full technical blueprint, split by section
- `docs/source/` — the design spec and playbook summary the blueprint was derived from
- `docs/bootstrap/` — how the repository was built before it ran its own SDLC (build order, plans)
- `sdlc/` — this repository's own lifecycle: `config.yaml`, templates, one directory per change

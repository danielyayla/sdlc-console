---
id: CHG-0011
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "pnpm build produces packages/web/dist; rendering the seed snapshot server-side shows 6 pipeline columns with the seed's 8 cards, the change detail stepper/viewer/gate panel, and Gates lists that swap when the role switches (acceptance e); sdlc serve serves the built app at /; build/test/lint green"
schema: 1
---
# Plan: Web — top bar, Pipeline, Change detail, Gates, tokens (1.2) (from spec.md n/a)

## Files that change
package.json
vitest.config.ts
eslint.config.js
packages/web/package.json (new)
packages/web/tsconfig.json (new)
packages/web/vite.config.ts (new)
packages/web/index.html (new)
packages/web/src/main.tsx (new)
packages/web/src/app.tsx (new)
packages/web/src/state.ts (new)
packages/web/src/api.ts (new)
packages/web/src/tokens.css (new)
packages/web/src/lib/format.ts (new)
packages/web/src/views/TopBar.tsx (new)
packages/web/src/views/Pipeline.tsx (new)
packages/web/src/views/ChangeDetail.tsx (new)
packages/web/src/views/Gates.tsx (new)
packages/web/src/views/Placeholder.tsx (new)
packages/web/src/views/Toast.tsx (new)
packages/web/test/format.test.ts (new)
packages/web/test/render.test.tsx (new)
packages/server/src/http.ts
packages/server/src/serve.ts
packages/cli/src/commands/serve.ts
docs/decisions.md
docs/build-order.md

## Order of work
1. Scaffold `@sdlc/web` (React 19 + Vite 8, TS with DOM lib and bundler resolution, `build = tsc --noEmit && vite build`); root `pnpm build` runs `tsc -b` then the web build; web tests run in Vitest's node environment via `react-dom/server`.
2. tokens.css: every §6 token as a CSS variable, kilnpulse as the only animation, typography stacks (Source Sans 3 / JetBrains Mono with fallbacks, no network fonts).
3. state.ts: `UIState {view, role, sel, art, toast}` reducer per spec §2/§5 (tab switch clears sel; role switch never changes view; accept resets art selection).
4. api.ts: fetch wrapper + WebSocket client that replaces the snapshot on every message; `act()` posts and returns the server's toast.
5. Views: TopBar (brand, tabs, badges hidden at 0, ACTING AS switcher seeded from defaultRole), Pipeline (6 columns, cards with agent chip and gate strip), ChangeDetail (header chips, stepper with dot states, lazy artifact viewer with header states, gate/no-gate panel by ownership incl. tech-lead notice, activity feed), Gates (YOURS/OTHER), placeholders for Sessions/Config/Loop/Security/Metrics.
6. Server serves `packages/web/dist` at `/` when present; CLI `serve` defaults to port 7331 and passes the web dir.
7. Tests: format helpers; server-side render of the seed snapshot for Pipeline, detail and Gates in both roles.

## Risks
- React 19 + Vite 8 are recent; pin exact minors in package.json.
- Server-side render covers markup, not interaction; interaction correctness rests on the reducer tests and the server's own tests.

## Proof
pnpm build (includes vite build), pnpm test (web render tests), pnpm lint.

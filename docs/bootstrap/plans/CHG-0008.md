---
id: CHG-0008
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "In a temporary git repo: sdlc init → change new → accept 1 → validate → audit all exit 0 with --json output parseable; accept refuses with SDLC_ACTOR_TYPE=agent and for the wrong role; loop produces cycle 2; build/test/lint green"
schema: 1
---
# Plan: CLI, build-order item 0.8 (from spec.md n/a)

## Files that change
packages/cli/package.json
packages/cli/tsconfig.build.json
packages/cli/src/index.ts
packages/cli/src/bin.ts (new)
packages/cli/src/main.ts (new)
packages/cli/src/io.ts (new)
packages/cli/src/context.ts (new)
packages/cli/src/templates.ts (new)
packages/cli/src/commands/init.ts (new)
packages/cli/src/commands/validate.ts (new)
packages/cli/src/commands/change.ts (new)
packages/cli/src/commands/gate.ts (new)
packages/cli/src/commands/loop.ts (new)
packages/cli/src/commands/audit.ts (new)
packages/cli/test/index.test.ts
packages/cli/test/cli.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. package.json: bin `sdlc` → dist/bin.js; deps on core, schemas, adapter-git.
2. io.ts: `Io {stdout, stderr, stdin, env, cwd}` so tests run `main(argv, io)` without a process; `--json` renders results as one JSON document; human output otherwise.
3. context.ts: repo root, identity (`SDLC_IDENTITY` override → git config), refuse mutations when `SDLC_ACTOR_TYPE=agent`, load committed tree (or `--working`), build TransitionContext with adapter ULIDs and blob shas, commit helper.
4. templates.ts: the four artifact templates embedded for `init`.
5. init: creates `sdlc/config.yaml` (identity holds po+eng), `sdlc/templates/*`, queue dirs with .gitkeep, `.gitattributes` merge=union, `.sdlc-state/` in .gitignore; never overwrites; prints what it created; `--product`/`--intent-home` recorded in config.
6. validate: `validateTree` on the tree at `--ref` (default HEAD) or `--working`, plus `validateIds` across branches; exit 1 on blocking.
7. change new/list/show: createChange (intent from `--intent <file|->` or template) committed on the current branch; list = table of id/stage/gate/agent/status; show = view summary or `--json` ChangeView.
8. accept/send-back: gate actions through core; gate 5 merges `pr.yaml.branch` first and passes the merge sha; exit codes 0/1/2 (2 = refused).
9. loop: optional `--incident <file>` commits incident.md first, then the gate-6 write-plan.
10. audit: walk the ledger per cycle, verify actor humanity/roles, SHA chaining, commit trailers ↔ event ids, manifest presence on agent-produced artifacts; print the chain; `clean: true|false`, exit 1 when broken.
11. Tests over a temp repo through `main()`.

## Risks
- `node:util.parseArgs` is minimal; subcommand parsing is hand-rolled but small.
- `audit` matches commits to events via the `SDLC-Event` trailer; commits made outside the CLI (fixtures) are reported, not failed, unless they rewrote the ledger.

## Proof
pnpm build, pnpm test (cli.test.ts end-to-end over a temp repo), pnpm lint; `node packages/cli/dist/bin.js --help` prints usage.

---
id: CHG-0003
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: "Every parser returns {value, diagnostics} and never throws on garbage; this repo's own CLAUDE.md parses to 3 verification commands; pnpm build/test/lint green"
schema: 1
---
# Plan: Parsers, build-order item 0.3 (from spec.md n/a)

## Files that change
packages/schemas/package.json
packages/schemas/src/index.ts
packages/schemas/src/bands.ts (new)
packages/schemas/src/registry.ts
packages/schemas/src/parse/result.ts (new)
packages/schemas/src/parse/yaml.ts (new)
packages/schemas/src/parse/json.ts (new)
packages/schemas/src/parse/jsonl.ts (new)
packages/schemas/src/parse/frontmatter.ts (new)
packages/schemas/src/parse/markdown.ts (new)
packages/schemas/src/parse/artifact.ts (new)
packages/schemas/src/parse/plan.ts (new)
packages/schemas/src/parse/claude-md.ts (new)
packages/schemas/src/parse/skill.ts (new)
packages/schemas/src/parse/agent.ts (new)
packages/schemas/src/parse/settings.ts (new)
packages/schemas/src/parse/bands.ts (new)
packages/schemas/src/parse/index.ts (new)
packages/schemas/json/bands.schema.json (new, generated)
packages/schemas/test/parse-files.test.ts (new)
packages/schemas/test/parse-artifacts.test.ts (new)
packages/schemas/test/parse-config.test.ts (new)
docs/decisions.md
docs/build-order.md

## Order of work
1. Add gray-matter and yaml to @sdlc/schemas; add a `bands` zod schema to the registry.
2. result.ts: ParseResult<T> = {ok, value, diagnostics}; helpers to build diagnostics with path/line/rule.
3. File-level parsers: yaml (yaml.parseDocument, errors carry linePos), json, jsonl (one event per line, line numbers) — each feeds validate(name).
4. frontmatter.ts over gray-matter; markdown.ts splits `#`/`##` sections with line numbers and detects `<placeholder>` bodies.
5. artifact.ts: required sections per template for intent/spec/plan/incident; missing → error, empty → warning; front-matter validated by schema.
6. plan.ts: "Files that change" → [{path, isNew}], acceptance line, order-of-work steps; header `(from spec.md <sha>)`.
7. claude-md.ts: word count vs ONE_PAGE_WORDS, "Verifying your work" → commands[{name, cmd, healthyOutput, singleTarget}], testGlobs, visualTool, maxLoopRounds; missing block → warning.
8. skill.ts, agent.ts: front-matter with name/description (+ owner/backed_by/must_hold; tools list).
9. settings.ts: `.claude/settings.json` hooks + permissions → Hook rows {name, phase, action, scope, matcher, script, warnings}; lint `ask` in edit/command phase.
10. bands.ts: bands.yaml → validated ControlBand[].
11. Tests with inline fixtures plus this repo's real CLAUDE.md and templates; regenerate json/; decisions; tick 0.3.

## Risks
- gray-matter is CommonJS with `export =`; default import under NodeNext must be checked at build time.
- The "Verifying your work" line format is a convention this repo defines; record it so CLAUDE.md authors can follow it.

## Proof
pnpm build, pnpm test (three new parser test files), pnpm lint; json-sync test still green after regenerating for the bands schema.

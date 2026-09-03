import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ONE_PAGE_WORDS,
  hookNameFromCommand,
  parseAgent,
  parseBands,
  parseClaudeMd,
  parseSettings,
  parseSkill,
} from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("parseClaudeMd", () => {
  it("parses this repo's CLAUDE.md: three single-target verification commands", () => {
    const r = parseClaudeMd(readFileSync(`${repoRoot}CLAUDE.md`, "utf8"), "CLAUDE.md");
    expect(r.ok).toBe(true);
    const v = r.value?.verification;
    expect(v?.commands.map((c) => [c.name, c.cmd, c.singleTarget])).toEqual([
      ["build", "pnpm build", true],
      ["test", "pnpm test", true],
      ["lint", "pnpm lint", true],
    ]);
    expect(v?.commands[0]?.healthyOutput).toBe("must finish with no errors");
    expect(v?.visualTool).toBeNull();
    expect(v?.maxLoopRounds).toBe(5);
    expect(r.value?.overOnePage).toBe(false);
    expect(r.value?.wordCount).toBeLessThan(ONE_PAGE_WORDS);
  });

  it("warns when the verification block is missing and when the file is over a page", () => {
    const long = `# X\n\n## Notes\n${"word ".repeat(ONE_PAGE_WORDS + 1)}\n`;
    const r = parseClaudeMd(long, "CLAUDE.md");
    expect(r.ok).toBe(true);
    expect(r.value?.verification).toBeNull();
    expect(r.value?.overOnePage).toBe(true);
    expect(r.diagnostics.map((d) => d.rule).sort()).toEqual([
      "claude-md.over-one-page",
      "claude-md.verification.missing",
    ]);
  });

  it("reads test globs, max rounds, a visual tool, and flags multi-step commands", () => {
    const text = `# P

## Verifying your work
- Build: \`make build\`
- Test: \`make test && make lint\` (all green)
- Visual: \`mcp-browser screenshot\`
- Test files: \`test/**/*.test.ts\`, \`e2e/**\`
- Max rounds: 8
`;
    const r = parseClaudeMd(text, "CLAUDE.md");
    const v = r.value?.verification;
    expect(v?.testGlobs).toEqual(["test/**/*.test.ts", "e2e/**"]);
    expect(v?.maxLoopRounds).toBe(8);
    expect(v?.visualTool).toBe("mcp-browser");
    expect(v?.commands.find((c) => c.name === "test")?.singleTarget).toBe(false);
    expect(r.diagnostics.map((d) => d.rule)).toContain("claude-md.command.multi-step");
  });

  it("finds the working rule and a version", () => {
    const r = parseClaudeMd("---\nversion: 3\n---\n# P\n- Make a mistake twice → add a line here.\n\n## Verifying your work\n- Test: `x`\n", "CLAUDE.md");
    expect(r.value?.version).toBe("3");
    expect(r.value?.workingRule).toMatch(/twice/);
  });
});

describe("parseSkill / parseAgent", () => {
  it("parses SKILL.md with governance keys", () => {
    const r = parseSkill("---\nname: brand\ndescription: Use when writing customer-facing copy.\nowner: marketing\nbacked_by: plan-sync\nmust_hold: true\n---\nBody\n", ".claude/skills/brand/SKILL.md");
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ name: "brand", owner: "marketing", backedBy: "plan-sync", mustHold: true });
  });
  it("falls back to the directory name and requires a description", () => {
    expect(parseSkill("---\ndescription: d\n---\n", "x/SKILL.md", "x").value?.name).toBe("x");
    expect(parseSkill("---\nname: y\n---\n", "y/SKILL.md").ok).toBe(false);
  });
  it("parses an agent with a comma-separated tools string or a list", () => {
    const a = parseAgent("---\nname: reviewer\ndescription: Reviews PRs\ntools: Read, Grep, Bash(git diff *)\nmodel: sonnet\n---\n", ".claude/agents/reviewer.md");
    expect(a.value).toMatchObject({ name: "reviewer", tools: ["Read", "Grep", "Bash(git diff *)"], model: "sonnet" });
    const b = parseAgent("---\ndescription: D\ntools: [Read, Edit]\n---\n", ".claude/agents/fixer.md", "fixer");
    expect(b.value).toMatchObject({ name: "fixer", tools: ["Read", "Edit"], model: null });
  });
});

describe("parseSettings", () => {
  const settings = JSON.stringify({
    permissions: { allow: ["Bash(pnpm test)"], ask: ["Edit"], deny: ["Bash(rm -rf *)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "sdlc hook test-freeze" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: ".claude/hooks/plan-sync.sh" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "sdlc hook verify-before-done" }] }],
    },
  });

  it("maps hooks and permissions to rows with phases and actions", () => {
    const r = parseSettings(settings, ".claude/settings.json");
    expect(r.ok).toBe(true);
    const rows = r.value?.hooks.map((h) => [h.name, h.phase, h.action, h.source]);
    expect(rows).toEqual([
      ["test-freeze", "edit", "block", "hooks"],
      ["plan-sync", "commit", "block", "hooks"],
      ["verify-before-done", "stop", "block", "hooks"],
      ["Bash(rm -rf *)", "command", "block", "permissions"],
      ["Edit", "edit", "ask", "permissions"],
      ["Bash(pnpm test)", "command", "allow", "permissions"],
    ]);
  });

  it("lints an ask rule in the edit phase as a warning, not an error", () => {
    const r = parseSettings(settings, ".claude/settings.json");
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", rule: "settings.hook.lint", message: expect.stringContaining("approval prompt in build") }),
    ]);
    expect(r.value?.hooks.find((h) => h.name === "Edit")?.warnings).toEqual(["approval prompt in build — move to PR gate"]);
  });

  it("derives hook names from commands", () => {
    expect(hookNameFromCommand("sdlc hook plan-sync")).toBe("plan-sync");
    expect(hookNameFromCommand("bash .claude/hooks/test-freeze.sh")).toBe("test-freeze");
    expect(hookNameFromCommand("prettier --check .")).toBe("prettier");
  });

  it("reports malformed files without throwing", () => {
    expect(parseSettings("{", ".claude/settings.json").ok).toBe(false);
    expect(parseSettings("[]", ".claude/settings.json").ok).toBe(false);
    expect(parseSettings('{"hooks": {"Stop": {}}}', ".claude/settings.json").ok).toBe(false);
    expect(parseSettings("{}", ".claude/settings.json").value?.hooks).toEqual([]);
  });
});

describe("parseBands", () => {
  it("parses bands.yaml", () => {
    const text = `baselineWindow: 30d
metrics:
  - metric: p95_latency_ms
    baseline: 310
    rules: [western-electric]
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep, "Bash(gh run view *)"] }
      3sigma: { action: propose, routes: [pr, "runbook:rollback"] }
runbooks: [rollback]
`;
    const r = parseBands(text, "bands.yaml");
    expect(r.diagnostics).toEqual([]);
    expect(r.value?.metrics[0]?.tiers["2sigma"].tools).toEqual(["Read", "Grep", "Bash(gh run view *)"]);
  });
  it("rejects a tier with the wrong action", () => {
    const r = parseBands("metrics:\n  - metric: m\n    baseline: 1\n    tiers:\n      1sigma: { action: propose }\n      2sigma: { action: diagnose, tools: [] }\n      3sigma: { action: propose, routes: [] }\n", "bands.yaml");
    expect(r.ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CAPABILITIES, COMMAND_HARNESS_CAPABILITIES, DEFAULT_HARNESS, degradedGuarantees, harnessFor, resolveConfig, resolveHarness } from "../src/index.js";

const BASE = { schema: 1 as const, defaultRole: "po" as const, identities: [{ id: "po@veri.example", roles: ["po" as const] }] };

describe("harness contract (3.8)", () => {
  it("Claude Code honours every managed guarantee: nothing is degraded", () => {
    expect(CLAUDE_CODE_CAPABILITIES).toEqual({ hooks: { PreToolUse: true, PostToolUse: true, Stop: true }, tools: { mcp: true, allowlist: true, worktree: true }, transcript: true, cost: true });
    expect(degradedGuarantees(CLAUDE_CODE_CAPABILITIES)).toEqual([]);
  });

  it("a command harness lacks hooks, allowlist, transcript and cost; each gap names its stand-in or says there is none", () => {
    expect(COMMAND_HARNESS_CAPABILITIES.hooks).toEqual({ PreToolUse: false, PostToolUse: false, Stop: false });
    expect(COMMAND_HARNESS_CAPABILITIES.tools).toEqual({ mcp: true, allowlist: false, worktree: true });
    const degraded = degradedGuarantees(COMMAND_HARNESS_CAPABILITIES);
    expect(degraded.map((d) => d.guarantee)).toEqual(["verify-before-done", "test-freeze", "plan-sync", "production-gate", "tool-allowlist", "transcript", "cost"]);
    const byName = Object.fromEntries(degraded.map((d) => [d.guarantee, d.reason]));
    expect(byName["verify-before-done"]).toContain("no Stop hook");
    expect(byName["verify-before-done"]).toContain("done-unverified");
    expect(byName["test-freeze"]).toContain("auto-finding");
    expect(byName["plan-sync"]).toContain("per-change run");
    expect(byName["production-gate"]).toContain("nothing stands in");
    expect(byName["tool-allowlist"]).toContain("not scoped by the harness");
    expect(byName["transcript"]).toContain("kept verbatim");
  });

  it("without MCP or a worktree the gaps are named too", () => {
    const none = degradedGuarantees({ hooks: { PreToolUse: true, PostToolUse: true, Stop: true }, tools: { mcp: false, allowlist: true, worktree: false }, transcript: true, cost: true });
    expect(none.map((d) => d.guarantee)).toEqual(["mcp", "worktree"]);
  });

  it("resolves config entries and picks the harness per session kind: scoped entry, then unscoped, then Claude Code", () => {
    const codex = resolveHarness({ kind: "command", id: "codex", command: "codex", args: ["exec", "{prompt}"], jobs: ["build", "review"] });
    expect(codex).toMatchObject({ id: "codex", kind: "command", command: "codex", args: ["exec", "{prompt}"], env: {}, bin: null, jobs: ["build", "review"], capabilities: COMMAND_HARNESS_CAPABILITIES });
    const anyAgent = resolveHarness({ kind: "command", command: "my-agent" });
    expect(anyAgent).toMatchObject({ id: "command", jobs: [] });
    const claude = resolveHarness({ kind: "claude-code", bin: "/opt/claude" });
    expect(claude).toMatchObject({ id: "claude-code", kind: "claude-code", bin: "/opt/claude", command: null, capabilities: CLAUDE_CODE_CAPABILITIES });

    expect(harnessFor([codex, anyAgent], "build").id).toBe("codex");
    expect(harnessFor([codex, anyAgent], "plan").id).toBe("command");
    expect(harnessFor([codex], "plan")).toBe(DEFAULT_HARNESS);
    expect(harnessFor([], "build")).toBe(DEFAULT_HARNESS);
    expect(DEFAULT_HARNESS.id).toBe("claude-code");
  });

  it("resolveConfig carries `harness` as a list whether one entry or several were written; absent = empty", () => {
    expect(resolveConfig({ ...BASE }).harnesses).toEqual([]);
    expect(resolveConfig({ ...BASE, harness: { kind: "command", command: "codex" } }).harnesses.map((h) => h.id)).toEqual(["command"]);
    const two = resolveConfig({ ...BASE, harness: [{ kind: "command", id: "codex", command: "codex", jobs: ["build"] }, { kind: "claude-code" }] });
    expect(two.harnesses.map((h) => [h.id, h.jobs])).toEqual([["codex", ["build"]], ["claude-code", []]]);
    expect(harnessFor(two.harnesses, "build").id).toBe("codex");
    expect(harnessFor(two.harnesses, "design").id).toBe("claude-code");
  });
});

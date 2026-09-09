import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { loadRepo, resolveConfig } from "@sdlc/core";
import { PO, seedSessions, seedTree } from "@sdlc/fixtures";
import { buildSnapshot } from "@sdlc/server";
import { App } from "../src/app";
import { initialState } from "../src/state";

const now = new Date("2026-09-03T12:00:00Z");
const repo = loadRepo(seedTree());
const DEGRADED = [
  { guarantee: "verify-before-done", reason: "no Stop hook — done is unverified unless the last recorded round is green with output; a red or missing round ends the session done-unverified and no run follows" },
  { guarantee: "tool-allowlist", reason: "no tool allowlist — read-only sessions and band tiers are not scoped by the harness; only the MCP server's own refusals apply" },
];
// the seed's first session (CHG-0018 build) ran through a command harness and ended done-unverified; the rest are Claude Code
const sessions = seedSessions().map((s, i) => (i === 0 ? { ...s, status: "done-unverified", harness: { id: "codex", degraded: DEGRADED }, standIn: { guarantee: "verify-before-done", allowed: false, reason: "verify-before-done: round 2 has test red — completion blocked", rounds: 2 } } : { ...s, harness: { id: "claude-code", degraded: [] } }));
const snapshot = buildSnapshot(repo, { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, sessions as never, 1, now);

const render = (state = initialState("po"), snap = snapshot) => renderToString(<App snapshot={snap} initial={state} now={now} live={false} />).replace(/<!-- -->/g, "");

describe("degraded-guarantee display (3.8)", () => {
  it("the session row names the harness and each unmet guarantee as words, plus the stand-in verdict; Claude Code sessions show nothing extra", () => {
    const html = render({ ...initialState("eng"), view: "sessions" });
    expect(html).toContain(">harness codex<");
    expect(html).toContain("verify-before-done — no Stop hook — done is unverified unless the last recorded round is green with output<");
    expect(html).toContain("tool-allowlist — no tool allowlist — read-only sessions and band tiers are not scoped by the harness<");
    expect(html).toContain('title="verify-before-done: no Stop hook — done is unverified unless the last recorded round is green with output; a red or missing round ends the session done-unverified and no run follows"');
    expect(html).toContain("verify-before-done stand-in: verify-before-done: round 2 has test red — completion blocked<");
    expect(html).toContain(">done-unverified · loop iterating");
    expect(html.match(/>harness /g) ?? []).toHaveLength(1);
    expect(html).not.toContain("harness claude-code");
  });

  it("the change detail lists the change's sessions as the first History rows with the same words", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0018" });
    expect(html).toContain('aria-label="history"');
    expect(html.indexOf("sess-0018-repro")).toBeLessThan(html.indexOf("committed intent.md"));
    expect(html).toContain("sess-0018-repro</span> · build · SUPERVISED · done-unverified — verify-before-done: round 2 has test red — completion blocked");
    expect(html).toContain(">harness codex<");
    expect(html).toContain("tool-allowlist — no tool allowlist");
    // a change without sessions has no session rows
    expect(render({ ...initialState("po"), view: "detail", sel: "CHG-0012" })).not.toContain('<span class="mono">sess-');
  });

  it("the Config view shows the harness table: Claude Code by default, and each configured entry with what it cannot honour", () => {
    const html = render({ ...initialState("po"), view: "config" });
    expect(html).toContain(">Harness · what runs the sessions and which guarantees it cannot honour<");
    expect(html).toContain("every managed guarantee honoured");
    const configured = { ...repo, config: resolveConfig({ ...(repo.rawConfig as Record<string, unknown>), harness: [{ kind: "command", id: "codex", command: "codex", args: ["exec", "--mcp-config", "{mcpConfig}", "{prompt}"], jobs: ["build"] }, { kind: "claude-code" }] } as never) };
    const snap = buildSnapshot(configured as never, { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, [], 1, now);
    const html2 = render({ ...initialState("po"), view: "config" }, snap);
    expect(html2).toContain(">codex<");
    expect(html2).toContain("codex exec --mcp-config {mcpConfig} {prompt}");
    expect(html2).toContain("<td>build</td>");
    expect(html2).toContain("⚠ verify-before-done — no Stop hook");
    expect(html2).toContain("⚠ production-gate — no PreToolUse hook — a production command typed in the session");
    expect(html2).toContain(">claude-code</td><td>all</td>");
  });
});

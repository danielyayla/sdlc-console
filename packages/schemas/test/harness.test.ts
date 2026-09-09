import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";
import { samples } from "./samples.js";

const started = { ...samples.event, actor: { type: "system", id: "sdlc-bot@sdlc.local" }, event: "session.started", data: { session: "sess-1", mode: "HEADLESS", worktree: "CHG-0018/export-fix" } };

describe("config.harness (3.8)", () => {
  it("accepts one entry or a list; claude-code takes a bin, command takes command/args/env/id/jobs", () => {
    expect(validate("config", { ...samples.config, harness: { kind: "claude-code", bin: "/opt/claude" } }).ok).toBe(true);
    expect(validate("config", { ...samples.config, harness: { kind: "command", id: "codex", command: "codex", args: ["exec", "--mcp-config", "{mcpConfig}", "{prompt}"], env: { CODEX_HOME: "{worktree}/.codex" }, jobs: ["build", "review"] } }).ok).toBe(true);
    expect(validate("config", { ...samples.config, harness: [{ kind: "command", command: "my-agent", jobs: ["build"] }, { kind: "claude-code" }] }).ok).toBe(true);
  });

  it("rejects an unknown kind, an unknown key, a bad id, an empty command and an unknown job kind", () => {
    expect(validate("config", { ...samples.config, harness: { kind: "codex", command: "codex" } }).ok).toBe(false);
    expect(validate("config", { ...samples.config, harness: { kind: "command", command: "codex", hooks: true } }).ok).toBe(false);
    expect(validate("config", { ...samples.config, harness: { kind: "command", id: "Codex!", command: "codex" } }).ok).toBe(false);
    expect(validate("config", { ...samples.config, harness: { kind: "command", command: "" } }).ok).toBe(false);
    expect(validate("config", { ...samples.config, harness: { kind: "command", command: "codex", jobs: ["deploy"] } }).ok).toBe(false);
    expect(validate("config", { ...samples.config, harness: [] }).ok).toBe(false);
  });
});

describe("session events (3.8)", () => {
  it("session.started carries the harness id and its degraded guarantees verbatim, optionally", () => {
    expect(validate("event", started).ok).toBe(true);
    const withHarness = { ...started, data: { ...started.data, harness: { id: "codex", degraded: [{ guarantee: "verify-before-done", reason: "no Stop hook — done is unverified unless the last recorded round is green" }] } } };
    expect(validate("event", withHarness).ok).toBe(true);
    expect(validate("event", { ...started, data: { ...started.data, harness: { id: "codex" } } }).ok).toBe(false);
    expect(validate("event", { ...started, data: { ...started.data, harness: { id: "codex", degraded: [{ guarantee: "x" }] } } }).ok).toBe(false);
  });

  it("session.stopped accepts `unverified` as a reason", () => {
    const stopped = { ...started, event: "session.stopped", data: { session: "sess-1", reason: "unverified" } };
    expect(validate("event", stopped).ok).toBe(true);
    expect(validate("event", { ...stopped, data: { session: "sess-1", reason: "half-done" } }).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { AGENT_TOOL_NAMES, PACKAGE_NAME, agentIdentity, loopState, sessionIdFrom, type StoredRound } from "../src/index.js";

const round = (n: number, pass: boolean, hash = "h", name = "test"): StoredRound => ({ n, ts: "2026-09-03T10:00:00Z", results: [{ name, pass, outputExcerpt: "x" }], dirtyHash: hash });

describe("@sdlc/mcp", () => {
  it("exports its package name and exactly eleven agent tools, none of which accepts anything", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/mcp");
    expect(AGENT_TOOL_NAMES).toHaveLength(11);
    expect(AGENT_TOOL_NAMES.some((n) => /accept|merge|approve|lift|confirm/.test(n))).toBe(false);
  });
  it("identity and session come from the launcher's environment", () => {
    expect(agentIdentity({})).toEqual({ id: "claude-code@sdlc.local", name: "claude-code" });
    expect(agentIdentity({ SDLC_AGENT_ID: "bot@x" }).id).toBe("bot@x");
    expect(sessionIdFrom({ SDLC_SESSION: "s9" })).toBe("s9");
    expect(sessionIdFrom({ SDLC_SESSION: "s9" }, "explicit")).toBe("explicit");
  });
  it("loop state: iterating, green, stalled by cap, stalled by the same failure 3 rounds, flaky", () => {
    expect(loopState([], 5)).toBe("not-run");
    expect(loopState([round(1, false)], 5)).toBe("iterating");
    expect(loopState([round(1, false, "a"), round(2, true, "b")], 5)).toBe("green");
    expect(loopState([round(1, false, "a"), round(2, true, "a")], 5)).toBe("flaky");
    expect(loopState([round(1, false), round(2, false), round(3, false)], 5)).toBe("stalled");
    expect(loopState([round(1, false, "a", "a"), round(2, false, "b", "b"), round(3, false, "c", "c"), round(4, false, "d", "d"), round(5, false, "e", "e"), round(6, false, "f", "f")], 5)).toBe("stalled");
  });
});

import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, changeIdFrom, parseHookInput } from "../src/index.js";

describe("@sdlc/hooks", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/hooks");
  });
  it("parses harness JSON leniently", () => {
    const i = parseHookInput('{"session_id":"s1","cwd":"/w","hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/w/test/a.test.ts"},"extra":1}', "/x");
    expect(i).toMatchObject({ session_id: "s1", cwd: "/w", tool_name: "Edit" });
    expect(parseHookInput("not json", "/x")).toMatchObject({ session_id: "unknown-session", cwd: "/x", hook_event_name: "" });
  });
  it("finds the change id in the branch or the environment", () => {
    expect(changeIdFrom("CHG-0018/export-fix", {})).toBe("CHG-0018");
    expect(changeIdFrom("main", { SDLC_CHANGE: "CHG-0020" })).toBe("CHG-0020");
    expect(changeIdFrom("main", {})).toBeNull();
    expect(changeIdFrom("feature/CHG-0018", {})).toBeNull();
  });
});

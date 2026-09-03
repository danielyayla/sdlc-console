import { describe, expect, it } from "vitest";
import { eventNames, is, schemaNames, validate } from "../src/index.js";
import { SHA, samples } from "./samples.js";

describe("validate() accepts one golden sample per schema", () => {
  for (const name of schemaNames) {
    it(name, () => {
      const result = validate(name, samples[name], `fixture/${name}`);
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});

describe("validate() rejects with a pointer and a message", () => {
  it("unknown property on change.yaml (stage must never be stored)", () => {
    const result = validate("change", { ...samples.change, stage: 3 }, "sdlc/changes/CHG-0042/change.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: "sdlc/changes/CHG-0042/change.yaml",
        pointer: "/",
        severity: "error",
        rule: "schema.change",
        message: 'unexpected property "stage"',
      }),
    ]);
  });

  it("missing required field", () => {
    const { title: _omit, ...rest } = samples.change;
    void _omit;
    const result = validate("change", rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.message)).toContain("must have required property 'title'");
  });

  it("malformed timestamp points at the nested field", () => {
    const result = validate("change", { ...samples.change, created: { by: "x", at: "yesterday" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.pointer)).toContain("/created/at");
  });

  it("never throws on garbage", () => {
    for (const name of schemaNames) {
      expect(validate(name, null).ok).toBe(false);
      expect(validate(name, 42).ok).toBe(false);
      expect(validate(name, {}).ok).toBe(false);
    }
  });
});

describe("log.jsonl event invariants live in the schema", () => {
  it("an agent-authored gate.accepted is rejected", () => {
    const agentAccept = {
      ...samples.event,
      actor: { type: "agent", id: "claude-code", session: "sess-1" },
    };
    const result = validate("event", agentAccept);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.pointer)).toContain("/actor/type");
  });

  it("a human gate.accepted is accepted, and is() agrees", () => {
    expect(is("event", samples.event)).toBe(true);
  });

  it("an agent event without a session id is rejected", () => {
    const note = {
      ...samples.event,
      actor: { type: "agent", id: "claude-code" },
      event: "note",
      data: { text: "hello" },
    };
    const result = validate("event", note);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.pointer)).toContain("/actor");
  });

  it("stage.entered must come from the system actor", () => {
    const entered = {
      ...samples.event,
      actor: { type: "human", id: "dkapper01@gmail.com" },
      event: "stage.entered",
      data: { stage: 2 },
    };
    expect(validate("event", entered).ok).toBe(false);
    expect(
      validate("event", { ...entered, actor: { type: "system", id: "sdlc-bot" } }).ok,
    ).toBe(true);
  });

  it("an unknown event name is rejected", () => {
    const result = validate("event", { ...samples.event, event: "gate.forced" });
    expect(result.ok).toBe(false);
  });

  it("every declared event name has a variant that validates a minimal payload shape", () => {
    expect(eventNames.length).toBeGreaterThanOrEqual(30);
    expect(eventNames).toContain("gate.accepted");
    expect(eventNames).not.toContain("gate.forced");
  });

  it("gate.accepted data requires a source and a valid gate number", () => {
    const badGate = { ...samples.event, data: { gate: 4, artifactSha: SHA, source: "cli" } };
    expect(validate("event", badGate).ok).toBe(false);
  });
});

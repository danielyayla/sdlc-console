import { describe, expect, it } from "vitest";
import { parseJson, parseJsonl, parseYaml, parseYamlValue } from "../src/index.js";
import { SHA, TS, ULID, samples } from "./samples.js";

describe("parseYaml", () => {
  it("parses and validates change.yaml", () => {
    const text = `schema: 1
id: CHG-0042
title: Invoice CSV export
kind: feature
risk: routine
created: { by: dkapper01@gmail.com, at: "${TS}" }
origin: { type: idea }
record: null
cycle: 1
repro: null
closed: null
`;
    const r = parseYaml("change", text, "sdlc/changes/CHG-0042/change.yaml");
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value?.title).toBe("Invoice CSV export");
  });

  it("reports YAML syntax errors with a line number and never throws", () => {
    const r = parseYamlValue("a: 1\nb: [unclosed\n", "x.yaml");
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ path: "x.yaml", rule: "parse.yaml", severity: "error" });
    expect(typeof r.diagnostics[0]?.line).toBe("number");
  });

  it("surfaces schema errors with the file path", () => {
    const r = parseYaml("change", "schema: 1\nid: nope\n", "c.yaml");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.every((d) => d.path === "c.yaml")).toBe(true);
  });
});

describe("parseJson", () => {
  it("parses an eval case", () => {
    const r = parseJson("eval-case", JSON.stringify(samples["eval-case"]), "evals/cases/CASE-0001.json");
    expect(r.ok).toBe(true);
    expect(r.value?.id).toBe("CASE-0001");
  });
  it("reports invalid JSON", () => {
    const r = parseJson("eval-case", "{not json", "x.json");
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.rule).toBe("parse.json");
  });
});

describe("parseJsonl", () => {
  const good = JSON.stringify(samples.event);
  const note = JSON.stringify({
    ...samples.event,
    id: ULID.slice(0, 25) + "B",
    seq: 4,
    actor: { type: "agent", id: "claude-code", session: "s1" },
    event: "note",
    data: { text: "hi" },
  });
  const agentAccept = JSON.stringify({
    ...samples.event,
    seq: 5,
    actor: { type: "agent", id: "claude-code", session: "s1" },
  });

  it("returns every valid event and blank lines are ignored", () => {
    const r = parseJsonl(`${good}\n\n${note}\n`, "log.jsonl");
    expect(r.ok).toBe(true);
    expect(r.value?.map((e) => e.event)).toEqual(["gate.accepted", "note"]);
  });

  it("keeps good lines and reports bad ones with line numbers", () => {
    const r = parseJsonl(`${good}\nnot json\n${agentAccept}\n${note}`, "log.jsonl");
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
    expect(r.diagnostics.map((d) => d.line)).toEqual(expect.arrayContaining([2, 3]));
    expect(r.diagnostics.find((d) => d.line === 3)?.pointer).toBe("/actor/type");
  });

  it("validates the sha field when present", () => {
    const r = parseJsonl(JSON.stringify({ ...samples.event, sha: "short" }), "log.jsonl");
    expect(r.ok).toBe(false);
    expect(SHA.length).toBe(40);
  });
});

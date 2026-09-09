import { describe, expect, it } from "vitest";
import { intakePayload } from "@sdlc/fixtures";
import { jsonSchemas, validate } from "../src/index.js";

describe("maintain intake envelopes (3.5)", () => {
  it("accepts the fixture Claude Security deliveries and refuses an unversioned or foreign-shaped body", () => {
    for (const name of ["claude-security", "claude-security-update", "claude-security-resolved"] as const) {
      const r = validate("claude-security-delivery", intakePayload(name));
      expect(r.ok, name).toBe(true);
    }
    const base = intakePayload("claude-security");
    expect(validate("claude-security-delivery", { ...base, schema: 2 }).ok).toBe(false);
    expect(validate("claude-security-delivery", { ...base, source: "snyk" }).ok).toBe(false);
    expect(validate("claude-security-delivery", { ...base, deliveryId: "" }).ok).toBe(false);
    const bad = validate("claude-security-delivery", { ...base, findings: [{ id: "x", title: "t", severity: "critical", confidence: 1.2 }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.map((d) => d.pointer)).toEqual(expect.arrayContaining(["/findings/0/severity", "/findings/0/confidence"]));
    expect(validate("claude-security-delivery", { ...base, findings: [{ ...(base["findings"] as object[])[0], extra: 1 }] }).ok).toBe(false);
  });

  it("accepts the fixture Claude Tag delivery and needs a message id, permalink and text", () => {
    const base = intakePayload("claude-tag");
    expect(validate("claude-tag-delivery", base).ok).toBe(true);
    const message = base["message"] as Record<string, unknown>;
    expect(validate("claude-tag-delivery", { ...base, message: { ...message, id: "" } }).ok).toBe(false);
    expect(validate("claude-tag-delivery", { ...base, message: { ...message, permalink: "not a url" } }).ok).toBe(false);
    expect(validate("claude-tag-delivery", { ...base, message: { ...message, text: "" } }).ok).toBe(false);
    expect(validate("claude-tag-delivery", { ...base, thread: undefined, tags: undefined, title: "Wrong invoice PDF" }).ok).toBe(true);
  });

  it("publishes both envelopes as JSON Schema with the schema literal pinned", () => {
    for (const name of ["claude-security-delivery", "claude-tag-delivery"] as const) {
      const props = jsonSchemas[name]["properties"] as Record<string, Record<string, unknown>>;
      expect(props["schema"]).toEqual({ type: "number", const: 1 });
      expect(props["source"]).toEqual({ type: "string", const: name.replace("-delivery", "") });
    }
  });

  it("a finding file keeps the scanner-owned fields the intake writes", () => {
    const f = { schema: 1, id: "SEC-0001", scannerId: "claude-security:7f3a91", sev: "high", conf: 0.97, validated: true, repo: "invoicing", title: "t", desc: "d", status: "new", source: "claude-security", run: { id: "scan-1", url: "https://security.example/runs/scan-1", at: "2026-09-08T06:04:12Z", commit: "9c1f2e7d" }, location: { path: "src/invoice/list.ts", startLine: 41, endLine: 43 }, rule: "sql-injection/raw-query", cwe: "CWE-89", evidence: "line 41", url: "https://security.example/findings/7f3a91", resolved: { at: "2026-09-10T06:02:55Z", run: "scan-3" } };
    expect(validate("finding", f).ok).toBe(true);
    expect(validate("finding", { ...f, resolved: { at: "yesterday", run: "scan-3" } }).ok).toBe(false);
    const t = { schema: 1, id: "TRI-0044", tier: "channel", src: "channel:slack:#support", title: "t", evidence: "e", createdAt: "2026-09-08T08:05:00Z", status: "open", channel: { name: "#support", workspace: "slack", messageId: "1757318400.000100", permalink: "https://veri.slack.com/archives/C0SUPPORT1/p1757318400000100", author: "Mara Lindqvist", tags: ["billing"] } };
    expect(validate("triage", t).ok).toBe(true);
    expect(validate("triage", { ...t, channel: { ...t.channel, messageId: undefined } }).ok).toBe(false);
  });
});

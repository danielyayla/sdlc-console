import { describe, expect, it } from "vitest";
import type { ClaudeSecurityDelivery, ClaudeTagDelivery } from "@sdlc/schemas";
import { ENG, PO, intakePayload, seedTree } from "@sdlc/fixtures";
import { acceptTriage, applyWritePlan, channelEvidence, dismissFinding, ingestChannelDelivery, ingestSecurityDelivery, loadRepo, securityScannerId, triageForMessage, validateWritePlan } from "../src/index.js";
import { SHA } from "./helpers.js";

const NOW = "2026-09-08T06:05:00Z";
const security = () => intakePayload<ClaudeSecurityDelivery>("claude-security");
const update = () => intakePayload<ClaudeSecurityDelivery>("claude-security-update");
const resolved = () => intakePayload<ClaudeSecurityDelivery>("claude-security-resolved");
const tag = () => intakePayload<ClaudeTagDelivery>("claude-tag");
const ctx = (id: string) => ({ now: NOW, newId: () => "01J8Z6Q7Y2K3M4N5P6Q7R8S9T0", actor: { id }, blobSha: () => SHA });

describe("Claude Security intake (3.5, FR-62)", () => {
  it("new scanner ids get the next SEC id as `new` with the scanner's fields verbatim; a known id is updated in place, never duplicated", () => {
    const repo = loadRepo(seedTree());
    // the seed already holds claude-security:7f3a91 as SEC-0118 (status new, conf 0.94)
    expect(repo.findings.find((f) => f.scannerId === securityScannerId("7f3a91"))?.id).toBe("SEC-0118");
    const r = ingestSecurityDelivery(repo, security(), { now: NOW });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.ingest).toEqual({ created: ["SEC-0121"], updated: ["SEC-0118"], resolved: [], unchanged: [], unknownResolved: [] });
    expect(r.plan.actor).toEqual({ type: "system", id: "sdlc-bot" });
    expect(r.plan.trailers).toEqual({ "SDLC-Actor": "system:sdlc-bot", "SDLC-Delivery": "claude-security:cs-delivery-0001", "SDLC-Scan": "scan-2026-09-08-01" });
    expect(r.plan.commitMessage).toBe("sdlc(security): claude-security run scan-2026-09-08-01 — 1 new, 1 updated");
    expect(r.plan.files.map((f) => f.path).sort()).toEqual(["sdlc/security/findings/SEC-0118.yaml", "sdlc/security/findings/SEC-0121.yaml"]);
    expect(validateWritePlan(repo, r.plan).blocking).toBe(false);
    const after = loadRepo(applyWritePlan(seedTree(), r.plan));
    expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const created = after.findings.find((f) => f.id === "SEC-0121");
    expect(created).toEqual({
      schema: 1,
      id: "SEC-0121",
      scannerId: "claude-security:a41c07",
      sev: "medium",
      conf: 0.88,
      validated: true,
      repo: "invoicing",
      title: "Webhook secret compared with ==",
      desc: "The webhook receiver compares the signature with a non-constant-time equality in src/webhooks/verify.ts.",
      status: "new",
      source: "claude-security",
      run: { id: "scan-2026-09-08-01", url: "https://security.example/runs/scan-2026-09-08-01", at: "2026-09-08T06:04:12Z", commit: "9c1f2e7d4b8a6f5e3d2c1b0a9f8e7d6c5b4a3f2e" },
      location: { path: "src/webhooks/verify.ts", startLine: 18 },
      rule: "crypto/timing-unsafe-compare",
      cwe: "CWE-208",
      evidence: "src/webhooks/verify.ts:18\n  if (given == expected) return true;",
      url: "https://security.example/findings/a41c07",
    });
    const updated = after.findings.find((f) => f.id === "SEC-0118");
    expect(updated).toMatchObject({ scannerId: "claude-security:7f3a91", conf: 0.97, status: "new", source: "claude-security", cwe: "CWE-89", location: { path: "src/invoice/list.ts", startLine: 41, endLine: 43 } });
    expect(updated?.evidence).toContain("validated: payload `sort=id;--` altered the query plan");
    expect(after.findings.filter((f) => f.scannerId === "claude-security:7f3a91")).toHaveLength(1);
    // the same delivery again: nothing changes, the transform refuses instead of writing an empty commit
    const again = ingestSecurityDelivery(after, security(), { now: NOW });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.diagnostics[0]?.rule).toBe("intake.nothing-new");
    expect(again.ingest).toEqual({ created: [], updated: [], resolved: [], unchanged: ["SEC-0118", "SEC-0121"], unknownResolved: [] });
  });

  it("the console's routing status survives a re-report: a dismissed finding stays dismissed and a patched one stays in the PR gate (Q12)", () => {
    const repo = loadRepo(seedTree());
    const dismissed = dismissFinding(repo, "SEC-0118", "false positive: sort is an enum", ctx(ENG));
    if (!dismissed.ok) throw new Error(JSON.stringify(dismissed.diagnostics));
    const tree = applyWritePlan(seedTree(), dismissed.plan);
    const r = ingestSecurityDelivery(loadRepo(tree), update(), { now: NOW });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.ingest?.updated).toEqual(["SEC-0118", "SEC-0120"]);
    const after = loadRepo(applyWritePlan(tree, r.plan));
    const f118 = after.findings.find((f) => f.id === "SEC-0118");
    expect(f118?.status).toBe("dismissed");
    expect(f118?.dismissal).toMatchObject({ by: ENG, reason: "false positive: sort is an enum" });
    expect(f118?.conf).toBe(0.99);
    expect(f118?.run?.id).toBe("scan-2026-09-09-01");
    const f120 = after.findings.find((f) => f.id === "SEC-0120");
    expect(f120).toMatchObject({ status: "patch_pr", patchPr: { number: 418 }, source: "claude-security", rule: "info-leak/stack-trace" });
    expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("`resolved` marks the finding without deleting it; an unknown resolved id is noted, not created; an open re-report clears the mark", () => {
    const first = ingestSecurityDelivery(loadRepo(seedTree()), security(), { now: NOW });
    if (!first.ok) throw new Error("first");
    const tree = applyWritePlan(seedTree(), first.plan);
    const r = ingestSecurityDelivery(loadRepo(tree), resolved(), { now: "2026-09-10T06:05:00Z" });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.ingest).toEqual({ created: [], updated: [], resolved: ["SEC-0121"], unchanged: [], unknownResolved: ["000000"] });
    expect(r.plan.commitMessage).toBe("sdlc(security): claude-security run scan-2026-09-10-01 — 1 resolved");
    const tree2 = applyWritePlan(tree, r.plan);
    const after = loadRepo(tree2);
    const f = after.findings.find((x) => x.id === "SEC-0121");
    expect(f?.status).toBe("new"); // routing status untouched; the view hides the actions while resolved
    expect(f?.resolved).toEqual({ at: "2026-09-10T06:02:55Z", run: "scan-2026-09-10-01" });
    expect(f?.evidence).toBe("src/webhooks/verify.ts:18 now uses timingSafeEqual; no longer reachable");
    expect(after.findings.some((x) => x.scannerId === "claude-security:000000")).toBe(false);
    // resolved again → unchanged; reported open again (a regression) → the mark is cleared
    const again = ingestSecurityDelivery(after, { ...resolved(), deliveryId: "cs-delivery-0004" }, { now: NOW });
    expect(again.ok).toBe(false);
    expect(again.ingest?.unchanged).toEqual(["SEC-0121"]);
    const reopened = ingestSecurityDelivery(after, { ...security(), deliveryId: "cs-delivery-0005", run: { id: "scan-2026-09-11-01" } }, { now: NOW });
    if (!reopened.ok) throw new Error("reopen");
    expect([...(reopened.ingest?.updated ?? [])].sort()).toEqual(["SEC-0118", "SEC-0121"]);
    const back = loadRepo(applyWritePlan(tree2, reopened.plan)).findings.find((x) => x.id === "SEC-0121");
    expect(back?.resolved).toBeUndefined();
    expect(back?.run).toEqual({ id: "scan-2026-09-11-01", at: NOW, commit: "9c1f2e7d4b8a6f5e3d2c1b0a9f8e7d6c5b4a3f2e" });
  });

  it("a delivery with no findings, or only unknown resolved ones, is refused as nothing new", () => {
    const repo = loadRepo(seedTree());
    const empty = ingestSecurityDelivery(repo, { ...security(), findings: [] }, { now: NOW });
    expect(empty.ok).toBe(false);
    const onlyUnknown = ingestSecurityDelivery(repo, { ...security(), findings: [{ id: "zzz", status: "resolved", title: "t", severity: "low", confidence: 0.1 }] }, { now: NOW });
    expect(onlyUnknown.ok).toBe(false);
    expect(onlyUnknown.ingest?.unknownResolved).toEqual(["zzz"]);
  });
});

describe("Claude Tag channel intake (3.5, FR-61)", () => {
  it("one `channel` item per message id with the message and thread verbatim, then Accept → Plan carries the origin unchanged", () => {
    const repo = loadRepo(seedTree());
    const r = ingestChannelDelivery(repo, tag(), { now: "2026-09-08T08:05:00Z" });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.id).toBe("TRI-0044");
    expect(r.plan.actor).toEqual({ type: "system", id: "sdlc-bot" });
    expect(r.plan.trailers).toEqual({ "SDLC-Actor": "system:sdlc-bot", "SDLC-Delivery": "claude-tag:ct-delivery-0001", "SDLC-Message": "1757318400.000100" });
    expect(r.plan.commitMessage).toBe("sdlc(loop): TRI-0044 from channel:slack:#support — Customers on the annual plan see last month's invoice PDF when they open this…");
    expect(validateWritePlan(repo, r.plan).blocking).toBe(false);
    const tree = applyWritePlan(seedTree(), r.plan);
    const after = loadRepo(tree);
    const item = after.triage.find((t) => t.data.id === "TRI-0044");
    expect(item?.data).toMatchObject({ tier: "channel", src: "channel:slack:#support", status: "open", createdAt: "2026-09-08T08:05:00Z", channel: { name: "#support", workspace: "slack", messageId: "1757318400.000100", permalink: "https://veri.slack.com/archives/C0SUPPORT1/p1757318400000100", author: "Mara Lindqvist", postedAt: "2026-09-08T08:00:00Z", tags: ["billing", "customer-facing"] } });
    expect(item?.data.evidence).toBe(channelEvidence(tag()));
    expect(item?.data.evidence).toContain("Mara Lindqvist in #support at 2026-09-08T08:00:00Z · tags: billing, customer-facing\nhttps://veri.slack.com/archives/C0SUPPORT1/p1757318400000100\n---\nCustomers on the annual plan");
    expect(item?.data.evidence).toContain("--- Eli Ng at 2026-09-08T08:01:00Z\nThe email link carries the invoice id");
    expect(item?.body).toContain("## Problem\nCustomers on the annual plan see last month's invoice PDF");
    expect(item?.body).toContain("- Eli Ng: The email link carries the invoice id");
    expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(triageForMessage(after, "1757318400.000100")?.id).toBe("TRI-0044");

    // a second delivery for the same message, whatever its delivery id, names the item and writes nothing
    const dup = ingestChannelDelivery(after, { ...tag(), deliveryId: "ct-delivery-0002" }, { now: "2026-09-08T08:06:00Z" });
    expect(dup.ok).toBe(false);
    expect(dup.duplicateOf).toBe("TRI-0044");
    if (!dup.ok) expect(dup.diagnostics[0]?.rule).toBe("intake.duplicate");

    // the existing Accept → Plan path: a new change whose intent is the pre-drafted body and whose origin is the item
    const accepted = acceptTriage(after, "TRI-0044", ctx(PO));
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.diagnostics));
    const changeId = accepted.plan.changeId ?? "";
    expect(changeId).toMatch(/^CHG-\d{4}$/);
    const done = loadRepo(applyWritePlan(tree, accepted.plan));
    expect(done.changes.get(changeId)?.change?.origin).toEqual({ type: "triage", ref: "TRI-0044" });
    expect(done.changes.get(changeId)?.intent?.body ?? "").toContain("Customers on the annual plan see last month's invoice PDF");
    expect(done.triage.some((t) => t.data.id === "TRI-0044")).toBe(false);
    // an accepted (deleted) item no longer dedupes: the same message tagged again after acceptance is a new item (the change already exists to link to)
    expect(triageForMessage(done, "1757318400.000100")).toBeNull();
  });

  it("uses the tagger's title when given, and the first line clipped to 80 characters otherwise; a dismissed item still dedupes", () => {
    const repo = loadRepo(seedTree());
    const titled = ingestChannelDelivery(repo, { ...tag(), title: "Wrong invoice PDF from email links (annual plan)", thread: undefined, tags: undefined }, { now: NOW });
    if (!titled.ok) throw new Error("titled");
    const after = loadRepo(applyWritePlan(seedTree(), titled.plan));
    const item = after.triage.find((t) => t.data.id === "TRI-0044");
    expect(item?.data.title).toBe("Wrong invoice PDF from email links (annual plan)");
    expect(item?.data.channel?.tags).toBeUndefined();
    expect(item?.data.evidence).not.toContain("tags:");
    expect(item?.body).toContain("What did the reporter expect to happen instead?");
    const short = ingestChannelDelivery(repo, { ...tag(), message: { ...tag().message, id: "m-2", text: "  \nPDF link is stale\nmore" } }, { now: NOW });
    if (!short.ok) throw new Error("short");
    expect(short.plan.commitMessage).toContain("— PDF link is stale");
  });
});

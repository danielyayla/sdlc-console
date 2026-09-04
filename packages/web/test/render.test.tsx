import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { loadRepo } from "@sdlc/core";
import { PO, seedSessions, seedTree } from "@sdlc/fixtures";
import { buildSnapshot } from "@sdlc/server";
import { App } from "../src/app";
import { initialState } from "../src/state";

const now = new Date("2026-09-03T12:00:00Z");
const repo = loadRepo(seedTree());
const snapshot = buildSnapshot(repo, { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, seedSessions() as never, 1, now);

// React's server renderer separates adjacent text nodes with <!-- -->; strip them so assertions read like the page.
const render = (state = initialState("po")) => renderToString(<App snapshot={snapshot} initial={state} now={now} live={false} />).replace(/<!-- -->/g, "");

describe("Pipeline (spec §4)", () => {
  it("renders six columns with the seed's eight cards, agent chips and gate strips", () => {
    const html = render();
    for (const name of ["01", "Plan", "02", "Design", "03", "Build", "04", "Test", "05", "Deploy", "06", "Maintain"]) expect(html).toContain(name);
    for (const id of ["CHG-0012", "CHG-0017", "CHG-0018", "CHG-0019", "CHG-0020", "CHG-0021", "CHG-0022", "CHG-0023"]) expect(html).toContain(id);
    expect(html).toContain("commits intent.md");
    expect(html).toContain("Accept intent.md");
    expect(html).toContain("Merge PR");
    expect(html).toContain("TECH LEAD");
    expect(html).toContain("⌁ agent");
    expect(html).toContain("Evals red — agent fixing");
    expect(html).not.toContain("Nothing here");
    // badges for po: gates 3, loop 2, security 2; hidden at 0 is exercised by eng below
    expect(html).toContain('class="badge">3<');
  });
});

describe("Change detail (spec §4)", () => {
  it("shows the stepper, viewer header, the gate panel with Accept for the owning role", () => {
    const html = render({ ...initialState("po"), view: "detail", sel: "CHG-0022" });
    expect(html).toContain("Multi-currency invoice totals");
    expect(html).toContain("← Pipeline");
    expect(html).toContain("intent.md");
    expect(html).toContain("Human gate");
    expect(html).toContain("Accept intent.md");
    expect(html).toContain(">Accept<");
    expect(html).toContain("Send back");
    expect(html).toContain("pending review · authoritative");
    expect(html).toContain("committed intent.md");
    const absent = render({ ...initialState("po"), view: "detail", sel: "CHG-0023" });
    expect(absent).toContain("Not committed yet — this artifact is produced when the stage runs.");
    expect(absent).toContain("not committed");
  });
  it("(e) the same change viewed as the engineer shows the waiting notice instead of Accept", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0022" });
    expect(html).toContain("Waiting on the product owner — switch role in the top bar to act.");
    expect(html).not.toContain(">Accept<");
  });
  it("(g) high-risk plan shows the tech-lead notice and no Accept, with Send back for the engineer", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0019" });
    expect(html).toContain("Accept plan.md · tech lead");
    expect(html).toContain("Waiting on tech lead — approval happens via PR review on plan.md.");
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("Send back");
    expect(html).toContain("draft rev 3");
  });
  it("shows the no-gate panel with the agent status and the auto-mode rationale", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0018" });
    expect(html).toContain("No gate open");
    expect(html).toContain("Evals red — agent fixing");
    expect(html).toContain("The next human gate opens when the artifact is committed.");
    expect(html).toContain("Auto mode");
    // 2.6: the design mock is named beside the rationale; CLAUDE.md has no Visual: line
    expect(html).toContain("mock export-dialog.svg · no visual tool in CLAUDE.md");
    // 2.7: the fix shows its committed repro test and the freeze; only an engineer can lift it once
    expect(html).toContain("Repro first · freeze active");
    expect(html).toContain("test/export/zero-total.test.ts");
    expect(html).toContain("e4a6f2d");
    expect(html).toContain("expected 4 rows, received 3");
    expect(html).toContain("Lift freeze once");
    const po = render({ ...initialState("po"), view: "detail", sel: "CHG-0018" });
    expect(po).toContain("Repro first · freeze active");
    expect(po).not.toContain("Lift freeze once");
  });
});

describe("Gates (acceptance e)", () => {
  it("swaps YOURS and OTHER when the role switches", () => {
    const po = render({ ...initialState("po"), view: "gates" });
    expect(po).toContain("Yours · product owner");
    expect(po.indexOf("CHG-0022")).toBeLessThan(po.indexOf("Other role"));
    expect(po.indexOf("CHG-0020")).toBeGreaterThan(po.indexOf("Other role"));
    const eng = render({ ...initialState("eng"), view: "gates" });
    expect(eng).toContain("Yours · engineer");
    expect(eng.indexOf("CHG-0020")).toBeLessThan(eng.indexOf("Other role"));
    expect(eng.indexOf("CHG-0022")).toBeGreaterThan(eng.indexOf("Other role"));
    expect(eng).toContain('class="badge">2<');
  });
});

describe("Loop, Security, Metrics (spec §4)", () => {
  it("Loop shows the bands table, the tier footer and both triage cards with their actions", () => {
    const html = render({ ...initialState("po"), view: "loop" });
    expect(html).toContain("p95_latency_ms");
    expect(html).toContain("no data · needs detection snapshots");
    expect(html).toContain("1σ log, 2σ diagnose read-only, 3σ propose via PR or pre-approved runbook.");
    expect(html).toContain("TRI-0042");
    expect(html).toContain("TRI-0043");
    expect(html).toContain("Accept → Plan");
    expect(html).toContain("Dismiss · tune band");
    expect(html).not.toContain("Queue clear");
  });
  it("Security shows severity chips, statuses, actions only while new, and the governance footer", () => {
    const html = render({ ...initialState("eng"), view: "security" });
    expect(html).toContain("SEC-0118");
    expect(html).toContain("SEC-0120");
    expect(html).toContain("patch in PR gate");
    expect(html).toContain("Patch → PR gate");
    expect(html).toContain("Wider than one patch → intent.md");
    expect(html).toContain("Dismiss with reason");
    expect((html.match(/Wider than one patch/g) ?? []).length).toBe(2);
    expect(html).toContain("the proposing agent cannot approve its own fix");
  });
  it("Metrics renders six stage cards with leading/lagging halves, source chips, the feeds header and % trend chips", () => {
    const html = render({ ...initialState("po"), view: "metrics" });
    expect((html.match(/class="half"/g) ?? []).length).toBe(12);
    expect(html).toContain("intents committed");
    expect(html).toContain("n/a · needs detection snapshots");
    expect(html).toContain("first-pass green");
    expect(html).toContain("67%");
    expect(html).toContain("PR metadata · git mirror");
    expect(html).toContain("incident records · git mirror");
    expect(html).toContain('<span class="metric-sources">pr</span>');
    expect(html).toContain("review time per PR");
    expect(html).toContain("median of 1 · review job");
    expect(html).toContain('title="previous window: 0"');
    expect(html).toContain("2 incidents open, none fixed in window");
  });
});

describe("Sessions (spec §4)", () => {
  it("renders the header counts, four seed cards with mode chips, waiting-on-you, rationale and the footer callout", () => {
    const html = render({ ...initialState("eng"), view: "sessions" });
    expect(html).toContain("2 active · review backlog 2 · ceiling 4"); // running + waiting; the done plan (CHG-0019 at stage 3) and design (CHG-0021 at stage 2) sessions await their gates
    expect(html).toContain("CHG-0018/export-fix");
    expect(html).toContain("PLAN MODE");
    expect(html).toContain("HEADLESS");
    expect(html).toContain("waiting on you: plan.md rev 2 marked final");
    expect(html).toContain("test edit attempts: 1");
    expect(html).toContain("New session");
    expect(html).toContain("Sessions run Claude Code headless in a worktree per task");
  });
  it("renders the visual rounds strip from the session's screenshot rounds and offers Downgrade only on running AUTO/HEADLESS cards", () => {
    const html = render({ ...initialState("eng"), view: "sessions" });
    expect(html).toContain('aria-label="visual rounds"');
    expect(html).toContain("round 1 · 14.2%");
    expect(html).toContain("round 2 · 3.1%");
    expect(html).toContain("chip red");
    expect(html).toContain("chip amber");
    // the seed's running session is SUPERVISED and the AUTO/HEADLESS ones are done: nothing to downgrade
    expect(html).not.toContain("Downgrade to SUPERVISED");
    expect(html).toContain("AUTO can be taken away, never granted");
  });
});

describe("Config (spec §4)", () => {
  it("renders CLAUDE.md, subagents, skills, hooks, records, proposals and the evals section from the seed", () => {
    const html = render({ ...initialState("eng"), view: "config" });
    expect(html).toContain("under one page");
    expect(html).toContain("mistake twice rule");
    expect(html).toContain("pnpm build");
    expect(html).toContain("reviewer");
    expect(html).toContain("marketing@veri.example");
    expect(html).toContain("plan-sync");
    expect(html).toContain("verify-before-done");
    expect(html).toContain("Managed hooks are deployed by the platform team");
    expect(html).toContain("intent: repo");
    expect(html).toContain("PRP-0007");
    expect(html).toContain("Never filter invoice rows by truthiness");
    expect(html).toContain("under-sized (&lt; 20)");
    expect(html).toContain("pass 100% · threshold 90%");
    expect(html).toContain("CASE-0003");
    expect(html).toContain("draft · checks missing");
    expect(html).toContain("Run suite");
    expect(html).toContain("budget n/a");
    expect(html).toContain("config PRs pass on RUN-0001");
    expect(html).toContain("RUN-0001 · schedule · pass 100%");
  });

  it("2.8: repeat signal with its proposal, proposal Accept for eng only, pending/merged chips, skills version · backed-by · pass % · findings citing", () => {
    const eng = render({ ...initialState("eng"), view: "config" });
    expect(eng).toContain("Repeat mistakes");
    expect(eng).toContain("commit touches files outside plan.md&#x27;s file list");
    expect(eng).toContain("from CHG-0017, CHG-0018");
    expect(eng).toContain("PRP-0008 open");
    expect(eng).toContain("seen 2×");
    expect(eng).toContain("Accept · open PR");
    expect(eng).not.toContain("no proposal yet");
    // skills row: version (blob sha7), backed by plan-sync (team), 100% on one trigger test, findings citing
    expect(eng).toContain(snapshot.skillStatus[0]?.version ?? "no-version");
    expect(eng).toContain("plan-sync</span>");
    expect(eng).toContain("100%</span>");
    expect(eng).toContain("1 trigger test · RUN-0001");
    expect(eng).toContain("Findings citing");
    expect(eng).toContain("threshold 80%");
    const po = render({ ...initialState("po"), view: "config" });
    expect(po).toContain('title="eng or platform accepts a proposal"');
    expect(po).toMatch(/<button class="btn primary" disabled="" title="eng or platform accepts a proposal"/);
  });

  it("a merged change shows the case it was harvested into (2.5)", () => {
    const html = render({ ...initialState("po"), view: "detail", sel: "CHG-0012" });
    expect(html).toContain("harvested as");
    expect(html).toContain("CASE-0002");
    expect(html).not.toContain("Add as eval");
  });
});

describe("Records mode (2.9, FR-16, spec 5A.6)", () => {
  it("the viewer header says copy of <record> · synced for an external artifact, the record chip links out, the Record panel lists the mode and sync, and Config shows the connector", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0012", art: 5 });
    expect(html).toContain("copy of servicenow INC0041207 · synced 2026-09-02 07:31");
    expect(html).toContain('href="https://servicenow.example/incident/INC0041207"');
    expect(html).toContain("Record · servicenow INC0041207");
    expect(html).toContain("incident.md · external");
    expect(html).not.toContain("write-back failed");
    const config = render({ ...initialState("eng"), view: "config" });
    expect(config).toContain("incident: external");
    expect(config).toContain("connector: records");
    // a repo-mode artifact keeps the plain header
    const intent = render({ ...initialState("po"), view: "detail", sel: "CHG-0022" });
    expect(intent).toContain("pending review · authoritative");
  });
});

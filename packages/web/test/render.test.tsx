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
  it("Metrics renders six stage cards with leading/lagging halves and n/a notes", () => {
    const html = render({ ...initialState("po"), view: "metrics" });
    expect((html.match(/class="half"/g) ?? []).length).toBe(12);
    expect(html).toContain("intents committed");
    expect(html).toContain("n/a · needs PR metadata");
    expect(html).toContain("first-pass green");
    expect(html).toContain("67%");
  });
});

describe("Sessions (spec §4)", () => {
  it("renders the header counts, four seed cards with mode chips, waiting-on-you, rationale and the footer callout", () => {
    const html = render({ ...initialState("eng"), view: "sessions" });
    expect(html).toContain("2 active · review backlog 2"); // running + waiting; two done sessions on changes before stage 6
    expect(html).toContain("CHG-0018/export-fix");
    expect(html).toContain("PLAN MODE");
    expect(html).toContain("HEADLESS");
    expect(html).toContain("waiting on you: plan.md rev 2 marked final");
    expect(html).toContain("test edit attempts: 1");
    expect(html).toContain("New session");
    expect(html).toContain("Sessions run Claude Code headless in a worktree per task");
  });
});

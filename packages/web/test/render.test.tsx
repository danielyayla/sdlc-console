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

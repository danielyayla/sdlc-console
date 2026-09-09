import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { accept, applyWritePlan, deriveChange, loadRepo, recordSessionDeploys, withFiles } from "@sdlc/core";
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
  it("renders six columns with the seed's eight cards, agent words and lit gate edges", () => {
    const html = render();
    for (const name of ["01", "Plan", "02", "Design", "03", "Build", "04", "Test", "05", "Deploy", "06", "Maintain"]) expect(html).toContain(name);
    for (const id of ["CHG-0012", "CHG-0017", "CHG-0018", "CHG-0019", "CHG-0020", "CHG-0021", "CHG-0022", "CHG-0023"]) expect(html).toContain(id);
    expect(html).toContain("incident → intent.md");
    expect(html).not.toContain('class="column');
    expect(html).toContain("Accept intent.md");
    expect(html).toContain("Merge PR");
    expect(html).toContain("· tech lead ·");
    expect(html).not.toContain("env-strip");
    // the agent word left line 1: the orange pulsing edge carries it, line 3 keeps the status words
    expect(html).not.toContain("agent-text pulse");
    expect(html).not.toContain(">routine<");
    expect(html).toContain('class="pcard edge-lit amber owned"');
    expect(html).toContain('class="pcard edge-lit agent pulse"');
    expect(html).not.toContain('class="card');
    expect(html).not.toContain("gate-strip");
    expect(html).toContain("Evals red — agent fixing");
    expect(html).not.toContain("Nothing here");
    // counts for po: gates 3, loop 2, security 2 — mono numerals, not badges; hidden at 0 is exercised by eng below
    expect(html).toContain('class="count">3<');
    expect(html).not.toContain("badge");
    // the headline is the decision count for the role, the sub-line the flight numbers
    expect(html).toContain("decisions wait on the product owner.");
    expect(html).toContain("changes in flight ·");
    expect(render(initialState("eng"))).toContain("decisions wait on the engineer.");
  });
});

describe("Change detail (spec §4)", () => {
  it("shows the stepper, viewer header, the Decision section with the accept verb for the owning role", () => {
    const html = render({ ...initialState("po"), view: "detail", sel: "CHG-0022" });
    expect(html).toContain("Multi-currency invoice totals");
    expect(html).toContain('<button class="btn text mono">Pipeline</button> · CHG-0022 · Plan');
    expect(html).toContain("intent.md");
    expect(html).toContain("Decision · waiting");
    expect(html).toContain("Owned by the product owner");
    expect(html).toContain('class="btn primary">Accept intent.md</button>');
    expect(html).toContain("Send back with feedback");
    expect(html).toContain("pending review · authoritative");
    expect(html).toContain("committed intent.md");
    const absent = render({ ...initialState("po"), view: "detail", sel: "CHG-0023" });
    expect(absent).toContain("Not committed yet — this artifact is produced when the stage runs.");
    expect(absent).toContain("not committed");
  });
  it("(e) the same change viewed as the engineer shows the waiting notice with Switch role instead of Accept", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0022" });
    expect(html).toContain("Waiting on the product owner.");
    expect(html).toContain(">Switch role</button>");
    expect(html).not.toContain('class="btn primary"');
  });
  it("(g) high-risk plan shows the tech-lead notice and no Accept, with Send back for the engineer", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0019" });
    expect(html).toContain("Accept plan.md · tech lead");
    expect(html).toContain("Approval happens via PR review on plan.md");
    expect(html).not.toContain('class="btn primary"');
    expect(html).toContain("Send back with feedback");
    expect(html).toContain("draft rev 3");
  });
  it("shows the no-decision section with the agent status, and the auto-mode terms and repro as Evidence rows", () => {
    const html = render({ ...initialState("eng"), view: "detail", sel: "CHG-0018" });
    expect(html).toContain("No decision open");
    expect(html).toContain("Evals red — agent fixing");
    expect(html).toContain("The next decision opens when the artifact is committed.");
    expect(html).toContain("auto mode · ");
    // 2.6: the design mock is named beside the rationale; CLAUDE.md has no Visual: line
    expect(html).toContain("mock export-dialog.svg");
    expect(html).toContain("no visual tool in CLAUDE.md");
    // 2.7: the fix shows its committed repro test and the freeze; only an engineer can lift it once
    expect(html).toContain("repro test frozen");
    expect(html).toContain("test/export/zero-total.test.ts");
    expect(html).toContain("e4a6f2d");
    expect(html).toContain("expected 4 rows, received 3");
    expect(html).toContain("Lift freeze once");
    // the session's blocked test edits are an Evidence row
    expect(html).toContain("test edit attempts");
    expect(html).toContain("1 blocked by test-freeze");
    const po = render({ ...initialState("po"), view: "detail", sel: "CHG-0018" });
    expect(po).toContain("repro test frozen");
    expect(po).not.toContain("Lift freeze once");
  });
});

describe("Gates (acceptance e)", () => {
  it("swaps YOURS and OTHER when the role switches", () => {
    const po = render({ ...initialState("po"), view: "gates" });
    expect(po).toContain("decisions wait on the product owner.");
    expect(po).toContain('class="grow edge-lit amber"');
    expect(po.indexOf("CHG-0022")).toBeLessThan(po.indexOf("Waiting on the engineer or tech lead"));
    expect(po.indexOf("CHG-0020")).toBeGreaterThan(po.indexOf("Waiting on the engineer or tech lead"));
    const eng = render({ ...initialState("eng"), view: "gates" });
    expect(eng).toContain("decisions wait on the engineer.");
    expect(eng.indexOf("CHG-0020")).toBeLessThan(eng.indexOf("Waiting on the product owner or tech lead"));
    expect(eng.indexOf("CHG-0022")).toBeGreaterThan(eng.indexOf("Waiting on the product owner or tech lead"));
    expect(eng).toContain('class="count">2<');
    expect(eng).not.toContain("Other role");
  });
  it("Pipeline and Gates headline numbers agree", () => {
    const count = (html: string) => {
      const m = /(\d+) decisions? waits? on the/.exec(html);
      return m ? Number(m[1]) : 0;
    };
    for (const role of ["po", "eng"] as const) {
      const board = count(render(initialState(role)));
      expect(board).toBe(count(render({ ...initialState(role), view: "gates" })));
      expect(board).toBe(role === "po" ? 3 : 2);
    }
  });
});

describe("Loop with detection snapshots (3.4)", () => {
  it("renders current, σ, tier and status per band from the snapshots, amber on a breach, with the triage item and job it raised", () => {
    const ts = "2026-09-03T11:45:00Z";
    const snapshots = {
      p95_latency_ms: [{ schema: 1 as const, metric: "p95_latency_ms", ts, baseline: 310, current: 842, sigma: 40, tier: 3 as const, breached: true, source: { command: "scripts/p95.sh", exitCode: 0, output: "842\n" } }],
      error_rate_pct: [{ schema: 1 as const, metric: "error_rate_pct", ts, baseline: 0.4, current: 0.45, sigma: 0.15, tier: 0 as const, breached: false, source: { command: "scripts/errors.sh", exitCode: 0, output: "0.45\n" } }],
    };
    // the seed's bands declare no source; give them one so the rows measure
    const seedBands = seedTree().files.get("bands.yaml")?.content ?? "";
    const measured = loadRepo(withFiles(seedTree(), { "bands.yaml": seedBands.replace("    sigma: 40\n", '    sigma: 40\n    source: "scripts/p95.sh"\n').replace("    sigma: 0.15\n", '    sigma: 0.15\n    source: "scripts/errors.sh"\n') }));
    const withSnapshots = buildSnapshot(measured, { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, seedSessions() as never, 1, now, undefined, snapshots);
    const jobs = [{ key: "band:p95_latency_ms:3σ:" + ts, kind: "propose", changeId: "", cycle: 0, stage: 6, state: "running", createdAt: ts, updatedAt: ts, sessionId: "sess-band1", error: null, note: null, traceId: null }];
    const html = renderToString(<App snapshot={withSnapshots} initial={{ ...initialState("po"), view: "loop" }} now={now} live={false} jobs={jobs} />).replace(/<!-- -->/g, "");
    expect(html).toContain('class="amber-text">842 ms'); // the current value goes amber on a breach; no row tint
    expect(html).toContain("842 ms");
    expect(html).toContain("3σ</span>");
    expect(html).toContain("3σ · propose · TRI-0042 · " + ts);
    expect(html).toContain(">TRI-0042</span>");
    expect(html).toContain("propose running · sess-band1");
    expect(html).toContain("0.45 %");
    expect(html).toContain("within 1σ · " + ts);
    expect(html).toContain("last " + ts);
  });
});

describe("Loop, Security, Metrics (spec §4)", () => {
  it("Loop shows the bands table, the tier footer and both triage items (lit by tier) with their actions", () => {
    const html = render({ ...initialState("po"), view: "loop" });
    expect(html).toContain("2 signals in the triage queue.");
    expect(html).toContain("p95_latency_ms");
    // the seed's bands declare no source: the row says so instead of pretending to measure (3.4)
    expect(html).toContain("no source · add `source:` to bands.yaml");
    expect(html).toContain("rolling 30d · Western Electric · detection every 15m · last never");
    expect(html).toContain("1σ log · 2σ diagnose read-only · 3σ propose via PR or runbook rollback");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("runbooks:");
    expect(html).not.toContain("Run detection"); // no engine injected
    expect(html).toContain("TRI-0042");
    expect(html).toContain("TRI-0043");
    expect(html).toContain("Accept → Plan");
    expect(html).toContain("Dismiss · tune band");
    expect(html).toContain('class="item edge-lit amber"');
    expect(html).toContain('class="when">2026-'); // the item's createdAt verbatim, right-aligned
    expect(html).not.toContain("Queue clear");
  });
  it("Security shows severity as the item's lit edge and word, statuses, actions only while new, and the governance footer", () => {
    const html = render({ ...initialState("eng"), view: "security" });
    expect(html).toContain("2 findings need a route."); // the seed has two new, unresolved findings — the same two that carry actions below
    expect(html).toContain("SEC-0118");
    expect(html).toContain("SEC-0120");
    expect(html).toContain("patch in PR gate");
    expect(html).toContain('class="item edge-lit red new primary-row"');
    expect(html).not.toContain('class="chip');
    expect(html).toContain("Patch → PR gate");
    expect(html).toContain("Wider than one patch → intent.md");
    expect(html).toContain("Dismiss with reason");
    expect((html.match(/Wider than one patch/g) ?? []).length).toBe(2);
    expect(html).toContain("the proposing agent cannot approve its own fix");
    expect(html).not.toContain('class="footer');
  });
  it("the first new finding is the only primary row", () => {
    const html = render({ ...initialState("eng"), view: "security" });
    expect((html.match(/primary-row/g) ?? []).length).toBe(1);
    const at = html.indexOf('primary-row"');
    expect(html.slice(at, html.indexOf("</article>", at))).toContain("SEC-0118");
  });
  it("Metrics renders six stage planes with leading/lagging halves, source words, the feeds line and trend words with %", () => {
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
    expect(html).toContain('class="trend mono green-text"');
    expect(html).not.toContain('class="chip');
    expect(html).toContain("2 incidents open, none fixed in window");
  });
});

describe("Sessions (spec §4)", () => {
  it("renders the header counts, four seed rows with mode words, waiting-on-you and rationale", () => {
    const html = render({ ...initialState("eng"), view: "sessions" });
    expect(html).toContain("2 active · review backlog 2 · ceiling 4"); // running + waiting; the done plan (CHG-0019 at stage 3) and design (CHG-0021 at stage 2) sessions await their gates
    expect(html).toContain("CHG-0018/export-fix");
    expect(html).toContain(">plan mode</span>");
    expect(html).toContain(">headless</span>");
    expect(html).toContain("waiting on you: plan.md rev 2 marked final");
    expect(html).toContain('<span class="red-text">test edits 1</span>');
    expect(html).toContain("New session");
    // the explanatory footer is documentation, not a control (removals log)
    expect(html).not.toContain("Sessions run Claude Code headless in a worktree per task");
  });
  it("renders the visual rounds as coloured words from the session's screenshot rounds and offers Downgrade only on running AUTO/HEADLESS rows", () => {
    const html = render({ ...initialState("eng"), view: "sessions", session: "sess-0018-repro" });
    expect(html).toContain('aria-label="visual rounds"');
    expect(html).toContain("round 1 · 14.2%");
    expect(html).toContain("round 2 · 3.1%");
    expect(html).toContain("btn text red-text");
    expect(html).toContain("btn text amber-text");
    // the seed's running session is SUPERVISED and the AUTO/HEADLESS ones are done: nothing to downgrade
    expect(html).not.toContain("Downgrade to supervised");
    // the running row shows Stop / Take over only once selected; the row waiting on you shows Add guidance unselected (usability exception)
    const unselected = render({ ...initialState("eng"), view: "sessions" });
    expect(unselected).not.toContain(">Stop</button>");
    expect(unselected).not.toContain('aria-label="visual rounds"');
    expect(unselected).toContain(">Add guidance</button>");
    expect(unselected).toContain('class="srow edge-lit amber primary-row"');
    expect(html).toContain('class="srow edge-lit agent pulse selected"');
    expect(html).toContain(">Stop</button>");
    expect(html).toContain(">Take over</button>");
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
    expect(html).toContain("managed · engineers cannot switch them off");
    expect(html).toContain("intent · repo");
    expect(html).toContain("PRP-0007");
    expect(html).toContain("Never filter invoice rows by truthiness");
    expect(html).toContain("under-sized · &lt; 20");
    expect(html).toContain('class="value tabular green-text">100%</div>');
    expect(html).toContain("threshold 90%");
    expect(html).toContain("CASE-0003");
    expect(html).toContain('class="btn text mono filter active" aria-pressed="true">all</button>');
    expect(html).toContain("draft · checks missing");
    expect(html).toContain("Run suite");
    expect(html).toContain(">budget</div><div class=\"value tabular \">n/a</div>");
    expect(html).toContain("config PRs pass on RUN-0001");
    expect(html).toContain("RUN-0001 · schedule · pass 100%");
  });

  it("2.8: a repeat signal is the seen N× on its proposal, proposal Accept for eng only, pending/merged chips, skills version · backed-by · pass % · findings citing", () => {
    const eng = render({ ...initialState("eng"), view: "config" });
    // the Repeat-mistakes section is gone: the signal shows as "seen N×" on the proposal that answers it
    expect(eng).not.toContain("Repeat mistakes");
    expect(eng).toContain("commit touches files outside plan.md&#x27;s file list"); // the reason stays on the proposal card
    expect(eng).toContain("from CHG-0017, CHG-0018");
    expect(eng).toContain("PRP-0008");
    expect(eng).toContain("seen 2×");
    expect(eng).toContain("Accept · open PR");
    expect(eng).not.toContain("no proposal yet");
    // skills row: version (blob sha7), backed by plan-sync (team), 100% on one trigger test, findings citing
    expect(eng).toContain(snapshot.skillStatus[0]?.version ?? "no-version");
    expect(eng).toContain("plan-sync</span>");
    expect(eng).toContain("100%</span>");
    expect(eng).toContain("1 trigger test · RUN-0001");
    expect(eng).toContain("findings citing");
    expect(eng).toContain("threshold 80%");
    // proposals come first and are the primary object; the product owner reads them and is offered the role switch
    expect(eng.indexOf("PRP-0007")).toBeLessThan(eng.indexOf('aria-label="evals"'));
    expect(eng).toContain('class="proposal edge-lit amber"');
    const po = render({ ...initialState("po"), view: "config" });
    expect(po).toContain("The engineer or platform decides.");
    expect(po).toContain(">Switch role</button>");
    expect(po).not.toContain("Accept · open PR");
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
    expect(html).toContain("record · ");
    expect(html).toContain("servicenow INC0041207</a>");
    expect(html).toContain("incident.md · external");
    expect(html).not.toContain("write-back failed");
    const config = render({ ...initialState("eng"), view: "config" });
    expect(config).toContain('<span class="amber-text">incident · external</span>');
    expect(config).toContain("connector records");
    // a repo-mode artifact keeps the plain header
    const intent = render({ ...initialState("po"), view: "detail", sel: "CHG-0022" });
    expect(intent).toContain("pending review · authoritative");
  });
});

describe("product switcher (3.2)", () => {
  const products = (n: number) => [{ name: "invoicing", root: "/r", home: "/r", prefix: "", primary: true, codeHost: "local", defaultBranch: "main", engine: false }, { name: "billing", root: "/r", home: "/r/apps/billing", prefix: "apps/billing/", primary: false, codeHost: "local", defaultBranch: "main", engine: false }].slice(0, n);
  const renderWith = (n: number, state = initialState("po")) => renderToString(<App snapshot={snapshot} initial={state} now={now} live={false} products={products(n)} />).replace(/<!-- -->/g, "");
  it("shows a select in the top bar only when the server holds more than one product; a single product keeps the repo label", () => {
    const two = renderWith(2);
    expect(two).toContain('aria-label="product"');
    expect(two).toContain('<option value="invoicing" title="/r" selected="">invoicing</option>');
    expect(two).toContain('<option value="billing" title="/r/apps/billing">billing</option>');
    expect(two).not.toContain("Veri</span><span> / invoicing</span>");
    const one = renderWith(1);
    expect(one).not.toContain('aria-label="product"');
    expect(one).toContain("Veri</span><span> / invoicing</span>");
    const none = render();
    expect(none).not.toContain('aria-label="product"');
    expect(none).toContain("Veri</span><span> / repo</span>");
  });
  it("the selected product is the one in UIState; switching keeps the tab, drops the selection and leaves the detail view", async () => {
    const { reduce } = await import("../src/state");
    const start = { ...initialState("eng"), view: "detail" as const, sel: "CHG-0022", art: 1 };
    const switched = reduce(start, { type: "product", name: "billing" });
    expect(switched).toMatchObject({ product: "billing", view: "board", sel: null, art: null, role: "eng" });
    expect(reduce({ ...start, view: "gates" }, { type: "product", name: "billing" }).view).toBe("gates");
    expect(reduce(switched, { type: "product", name: "billing" })).toBe(switched);
    expect(renderWith(2, switched)).toContain('<option value="billing" title="/r/apps/billing" selected="">');
    expect(renderWith(2, switched)).not.toContain('<option value="invoicing" title="/r" selected="">');
  });
});

describe("maintain intake in the views (3.5)", () => {
  it("Security shows the source, confidence, location, run link and evidence of an ingested finding, and hides the actions once the scanner resolved it", () => {
    const ingested = "schema: 1\nid: SEC-0121\nscannerId: claude-security:a41c07\nsev: medium\nconf: 0.88\nvalidated: true\nrepo: invoicing\ntitle: Webhook secret compared with ==\ndesc: Non-constant-time compare.\nstatus: new\nsource: claude-security\nrun:\n  id: scan-2026-09-08-01\n  url: https://security.example/runs/scan-2026-09-08-01\n  at: 2026-09-08T06:04:12Z\nlocation:\n  path: src/webhooks/verify.ts\n  startLine: 18\nrule: crypto/timing-unsafe-compare\ncwe: CWE-208\nevidence: |-\n  src/webhooks/verify.ts:18\n    if (given == expected) return true;\nurl: https://security.example/findings/a41c07\n";
    const resolved = ingested.replace("SEC-0121", "SEC-0122").replace("a41c07", "b52d18").replace("Webhook secret compared with ==", "Stale PDF cache key") + "resolved:\n  at: 2026-09-10T06:02:55Z\n  run: scan-2026-09-10-01\n";
    const repo = loadRepo(withFiles(seedTree(), { "sdlc/security/findings/SEC-0121.yaml": ingested, "sdlc/security/findings/SEC-0122.yaml": resolved }));
    const snap = buildSnapshot(repo, { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, seedSessions() as never, 1, now);
    const html = renderToString(<App snapshot={snap} initial={{ ...initialState("eng"), view: "security" }} now={now} live={false} />).replace(/<!-- -->/g, "");
    expect(html).toContain("SEC-0121");
    expect(html).toContain(">claude-security</span>");
    expect(html).toContain("validated · 0.88");
    expect(html).toContain("src/webhooks/verify.ts:18");
    expect(html).toContain("crypto/timing-unsafe-compare");
    expect(html).toContain("CWE-208");
    expect(html).toContain('href="https://security.example/runs/scan-2026-09-08-01"');
    expect(html).toContain("if (given == expected) return true;");
    expect(html).toContain("3 findings need a route."); // the seed's two plus SEC-0121; SEC-0122 is resolved
    expect(html).toContain("last run 2026-09-08T06:04:12Z");
    expect(html).toContain("resolved by scanner · 2026-09-10T06:02:55Z");
    // the edge colour follows severity; the glow (and the `new` class that lights it) only while the finding still needs a route
    expect(html).toContain('class="item edge-lit amber new"');
    expect(html).toContain('class="item edge-lit amber dismissed"');
    // actions: the three seed findings have one `new` (SEC-0118) plus SEC-0121; SEC-0122 is resolved and shows none
    expect((html.match(/Wider than one patch/g) ?? []).length).toBe(3);
  });
  it("Loop shows a channel item with its author, permalink and tags beside the evidence", () => {
    const item = "---\nschema: 1\nid: TRI-0044\ntier: channel\nsrc: channel:slack:#support\ntitle: Wrong invoice PDF from email links\nevidence: |\n  Mara Lindqvist in #support\n  https://veri.slack.com/archives/C0SUPPORT1/p1757318400000100\ncreatedAt: 2026-09-08T08:05:00Z\nstatus: open\nchannel:\n  name: '#support'\n  workspace: slack\n  messageId: '1757318400.000100'\n  permalink: https://veri.slack.com/archives/C0SUPPORT1/p1757318400000100\n  author: Mara Lindqvist\n  tags:\n    - billing\n---\n# Intent: Wrong invoice PDF\n\n## Problem\nStale PDF.\n";
    const repo = loadRepo(withFiles(seedTree(), { "sdlc/loop/triage/TRI-0044.md": item }));
    const snap = buildSnapshot(repo, { id: PO, name: "Priya Owens", roles: ["po"] }, seedSessions() as never, 1, now);
    const html = renderToString(<App snapshot={snap} initial={{ ...initialState("po"), view: "loop" }} now={now} live={false} />).replace(/<!-- -->/g, "");
    expect(html).toContain("TRI-0044");
    expect(html).toContain(">channel</span>");
    expect(html).toContain('href="https://veri.slack.com/archives/C0SUPPORT1/p1757318400000100"');
    expect(html).toContain("Mara Lindqvist · ");
    expect(html).toContain(">billing</span>");
    expect((html.match(/Accept → Plan/g) ?? []).length).toBe(3);
  });
});

describe("Deployment (3.6): environments, the production gate and the board", () => {
  const ENG_ID = "eng@veri.example";
  const ctx = (id: string, extra: Record<string, unknown> = {}) => ({ now: "2026-09-03T11:00:00Z", newId: (() => { let n = 0; return () => `01J8Z6Q7Y2K3M4N5P6Q7R8T${(++n).toString(36).toUpperCase().padStart(3, "0")}`.replace(/[ILOU]/g, "X"); })(), actor: { id }, ...extra });
  const MERGE = "c2e4d0b3e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b4";
  /** The seed with CHG-0017 merged (gate 5, local mode): the production gate is open. */
  function mergedTree() {
    const tree = seedTree();
    const r0 = loadRepo(tree);
    const f = r0.changes.get("CHG-0017");
    if (!f) throw new Error("CHG-0017");
    const r = accept(r0, deriveChange(r0, f), 5, ctx(ENG_ID, { mergeSha: MERGE }) as never);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    return applyWritePlan(tree, r.plan);
  }
  function rehearsedTree() {
    const tree = mergedTree();
    const r0 = loadRepo(tree);
    const f = r0.changes.get("CHG-0017");
    if (!f) throw new Error("CHG-0017");
    const r = recordSessionDeploys(r0, deriveChange(r0, f), [{ kind: "deploy", env: "staging", sha: MERGE, startedAt: "2026-09-03T11:10:00Z", finishedAt: "2026-09-03T11:12:00Z", exitCode: 0, output: "deploy staging c2e4d0b\nrelease 2 live\n" }, { kind: "rehearsal", env: "staging", sha: MERGE, rehearsedAt: "2026-09-03T11:15:00Z", exitCode: 0, output: "rollback staging to previous release\nrelease 1 live\n" }], { type: "agent", id: "claude-code@sdlc.local", session: "sess-0017-deploy" }, ctx("sdlc-bot@sdlc.local") as never);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    return applyWritePlan(tree, r.plan);
  }
  const renderTree = (tree: ReturnType<typeof seedTree>, state = initialState("eng")) => {
    const snap = buildSnapshot(loadRepo(tree), { id: ENG_ID, name: "Eli Ng", roles: ["eng"] }, seedSessions() as never, 1, now);
    return { snap, html: renderToString(<App snapshot={snap} initial={state} now={now} live={false} />).replace(/<!-- -->/g, "") };
  };

  it("the detail lists the seed's environments; a stage-6 change with a pre-3.6 production record reads deployed", () => {
    const html = render({ ...initialState("po"), view: "detail", sel: "CHG-0012" });
    expect(html).toContain("preview");
    expect(html).toContain("not deployed");
    expect(html).toContain("production");
    expect(html).toContain("succeeded");
    // the board: Deploy-stage cards carry the environments as words on line 3
    const board = render();
    expect(board).toContain('aria-label="environments"');
    expect(board).toContain("· staging");
  });

  it("after the merge the production gate is the Decision and waits on the rehearsal with Deploy disabled, and queues for the engineer; after a rehearsed rollback the evidence shows verbatim and Deploy is live", () => {
    const merged = renderTree(mergedTree(), { ...initialState("eng"), view: "detail", sel: "CHG-0017" });
    expect(merged.html).toContain("Decision · waiting");
    expect(merged.html).toContain('class="primary">Deploy c2e4d0b to production</div>');
    expect(merged.html).toContain("Owned by the engineer");
    expect(merged.html).toContain("sdlc/rollback-rehearsed");
    expect(merged.html).toContain("no rollback rehearsal recorded");
    expect(merged.html).toMatch(/<button class="btn primary" disabled="" title="sdlc\/rollback-rehearsed is pending[^"]*">Deploy to production<\/button>/);
    expect(merged.html).toContain("Merged · production gate needs a rollback rehearsal");
    const gates = renderTree(mergedTree(), { ...initialState("eng"), view: "gates" });
    expect(gates.snap.queues.eng.yours).toContain("CHG-0017");
    expect(gates.html).toContain("Deploy to production");
    expect(gates.html).toContain("rollback rehearsal pending");
    const po = renderTree(mergedTree(), { ...initialState("po"), view: "detail", sel: "CHG-0017" });
    expect(po.html).toContain("Waiting on the engineer.");

    const ready = renderTree(rehearsedTree(), { ...initialState("eng"), view: "detail", sel: "CHG-0017" });
    expect(ready.html).toContain("rollback staging to previous release\nrelease 1 live");
    expect(ready.html).toContain("deploy staging c2e4d0b\nrelease 2 live");
    expect(ready.html).toContain("rollback rehearsed on staging at c2e4d0b by claude-code@sdlc.local");
    expect(ready.html).toMatch(/<button class="btn primary" title="runs the declared deploy command for production[^"]*">Deploy to production<\/button>/);
    expect(ready.html).toContain("Rehearse rollback");
    expect(ready.snap.changes.find((c) => c.id === "CHG-0017")?.status).toBe("Merged · production gate — waiting on the engineer");
  });
});

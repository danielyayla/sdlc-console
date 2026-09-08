import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { loadRepo } from "@sdlc/core";
import { PO, seedSessions, seedTree } from "@sdlc/fixtures";
import { buildSnapshot } from "@sdlc/server";
import { App } from "../src/app";
import type { JobRow } from "../src/api";
import { traceUrl } from "../src/lib/format";
import { initialState } from "../src/state";

const now = new Date("2026-09-03T12:00:00Z");
const repo = loadRepo(seedTree());
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const sessions = seedSessions().map((s, i) => (i === 0 ? { ...s, traceId: TRACE } : s));
const snapshot = buildSnapshot(repo, { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, sessions as never, 1, now);
const jobs: JobRow[] = [
  { key: "CHG-0018:1:4:run:sess-1:r0:abcdef123456", kind: "per-change-run", changeId: "CHG-0018", cycle: 1, stage: 4, state: "done", createdAt: "2026-09-03T11:00:00Z", updatedAt: "2026-09-03T11:05:00Z", sessionId: "sess-1", error: null, note: "run 2 green · PR opened", traceId: "1b2c3d4e5f60718293a4b5c6d7e8f901" },
  { key: "evals:manual:RUN-0004", kind: "evals-run", changeId: "", cycle: 0, stage: 4, state: "failed", createdAt: "2026-09-03T11:10:00Z", updatedAt: "2026-09-03T11:12:00Z", sessionId: null, error: "budget exhausted", note: null, traceId: null },
];

const render = (state = initialState("po"), template: string | null = null) => renderToString(<App snapshot={snapshot} initial={state} now={now} live={false} jobs={jobs} traceUrlTemplate={template} />).replace(/<!-- -->/g, "");

describe("traceUrl", () => {
  it("substitutes {traceId}, appends without a placeholder, and is null without a template or an id", () => {
    expect(traceUrl("https://jaeger.example/trace/{traceId}", TRACE)).toBe(`https://jaeger.example/trace/${TRACE}`);
    expect(traceUrl("https://tempo.example/explore?traceId=", TRACE)).toBe(`https://tempo.example/explore?traceId=${TRACE}`);
    expect(traceUrl(null, TRACE)).toBeNull();
    expect(traceUrl("https://jaeger.example/trace/{traceId}", null)).toBeNull();
  });
});

describe("Change detail · Export (3.3)", () => {
  it("offers the compliance export as a download from the API", () => {
    const html = render({ ...initialState("po"), view: "detail", sel: "CHG-0012" });
    expect(html).toContain('href="/api/changes/CHG-0012/export"');
    expect(html).toContain('download="CHG-0012-export.json"');
    expect(html).toContain(">Export<");
  });
});

describe("Sessions · trace links and jobs (3.3)", () => {
  it("links sessions and jobs to their traces only when the server has a URL template", () => {
    const without = render({ ...initialState("eng"), view: "sessions" });
    expect(without).not.toContain(">trace<");
    expect(without).toContain("Jobs · 2");
    expect(without).toContain("per-change-run");
    expect(without).toContain("run 2 green · PR opened");
    expect(without).toContain("budget exhausted");
    const html = render({ ...initialState("eng"), view: "sessions" }, "https://jaeger.example/trace/{traceId}");
    expect(html).toContain(`href="https://jaeger.example/trace/${TRACE}"`);
    expect(html).toContain('href="https://jaeger.example/trace/1b2c3d4e5f60718293a4b5c6d7e8f901"');
    // the job without a trace id shows no link even with the template
    expect(html.split(">trace<").length - 1).toBe(2);
  });
});

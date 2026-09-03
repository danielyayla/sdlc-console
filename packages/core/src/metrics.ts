import type { Event } from "@sdlc/schemas";
import type { ChangeView } from "./derive.js";
import { eventsNamed } from "./events.js";
import type { Repo } from "./repo.js";
import { STAGES, type StageNumber } from "./stages.js";

export type Trend = "up" | "flat" | "down" | null;

export interface MetricValue {
  name: string;
  /** null = not computable from the available sources. */
  value: number | null;
  unit: "count" | "hours" | "pct" | "words" | "avg";
  /** Shown beside the value: sample size, or "n/a · needs <source>". */
  note: string;
  trend: Trend;
  /** Which direction is an improvement, for colouring the trend chip. */
  better: "up" | "down";
}

export interface StageMetrics {
  stage: StageNumber;
  name: string;
  leading: MetricValue[];
  lagging: MetricValue[];
}

export interface MetricsOptions {
  now: string;
  windowDays?: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  return m === undefined ? null : Math.round(m * 10) / 10;
}

function trendOf(current: number | null, previous: number | null): Trend {
  if (current === null || previous === null) return null;
  if (previous === 0 && current === 0) return "flat";
  const delta = previous === 0 ? 1 : (current - previous) / Math.abs(previous);
  if (delta > 0.05) return "up";
  if (delta < -0.05) return "down";
  return "flat";
}

function na(name: string, unit: MetricValue["unit"], source: string, better: "up" | "down"): MetricValue {
  return { name, value: null, unit, note: `n/a · needs ${source}`, trend: null, better };
}

interface Window {
  from: number;
  to: number;
}

function inWindow(ts: string, w: Window): boolean {
  const t = Date.parse(ts);
  return t >= w.from && t < w.to;
}

interface Inputs {
  repo: Repo;
  views: readonly ChangeView[];
  events: Event[];
  window: Window;
}

type Computer = (i: Inputs) => { value: number | null; note: string };

function count(pred: (e: Event) => boolean): Computer {
  return (i) => {
    const n = i.events.filter((e) => inWindow(e.ts, i.window) && pred(e)).length;
    return { value: n, note: "30-day window" };
  };
}

/** Median hours from the artifact commit that opened a gate to its acceptance. */
function gateLatency(gate: 1 | 2 | 3 | 5 | 6, artifactIndex: number): Computer {
  return (i) => {
    const hours: number[] = [];
    for (const files of i.repo.changes.values()) {
      const accepts = eventsNamed(files.events, "gate.accepted").filter((e) => e.data.gate === gate && inWindow(e.ts, i.window));
      for (const acc of accepts) {
        const opened = [...eventsNamed(files.events, "artifact.committed")].reverse().find((e) => e.data.artifact === artifactIndex && e.cycle === acc.cycle && Date.parse(e.ts) <= Date.parse(acc.ts));
        if (opened) hours.push((Date.parse(acc.ts) - Date.parse(opened.ts)) / HOUR);
      }
    }
    const m = median(hours);
    return { value: m, note: m === null ? "no decisions in window" : `median of ${hours.length}` };
  };
}

function metric(name: string, unit: MetricValue["unit"], better: "up" | "down", compute: Computer, inputs: Inputs, previous: Inputs): MetricValue {
  const cur = compute(inputs);
  const prev = compute(previous);
  return { name, value: cur.value, unit, note: cur.note, trend: trendOf(cur.value, prev.value), better };
}

/** Per-stage leading/lagging metrics from git + ledger only (FR-70, decisions Q13). */
export function computeMetrics(repo: Repo, views: readonly ChangeView[], opts: MetricsOptions): StageMetrics[] {
  const days = opts.windowDays ?? 30;
  const to = Date.parse(opts.now);
  const cur: Window = { from: to - days * DAY, to };
  const prev: Window = { from: cur.from - days * DAY, to: cur.from };
  const events = [...repo.changes.values()].flatMap((f) => f.events);
  const inputs: Inputs = { repo, views, events, window: cur };
  const previous: Inputs = { repo, views, events, window: prev };
  const m = (name: string, unit: MetricValue["unit"], better: "up" | "down", c: Computer) => metric(name, unit, better, c, inputs, previous);

  const staleDocs = (index: 0 | 1 | 2) => (i: Inputs) => ({ value: i.views.filter((v) => v.docs[index].state === "stale").length, note: "artifacts edited after acceptance" });
  const claudeWords = (i: Inputs) => ({ value: i.repo.claudeMd?.wordCount ?? null, note: i.repo.claudeMd ? (i.repo.claudeMd.overOnePage ? "over one page" : "under one page") : "n/a · needs CLAUDE.md" });
  const planRevs = (i: Inputs) => {
    const revs = i.views.filter((v) => v.planState === "committed").map((v) => v.planRev);
    return { value: revs.length ? Math.round((revs.reduce((a, b) => a + b, 0) / revs.length) * 10) / 10 : null, note: revs.length ? `avg over ${revs.length} accepted plans` : "no accepted plans" };
  };
  const repeatReasons = (i: Inputs) => {
    const reasons = new Map<string, number>();
    for (const e of i.events) {
      if (!inWindow(e.ts, i.window)) continue;
      const r = e.event === "hook.blocked" ? e.data.reason : e.event === "gate.sent_back" ? e.data.feedback : null;
      if (r) reasons.set(r.trim().toLowerCase(), (reasons.get(r.trim().toLowerCase()) ?? 0) + 1);
    }
    return { value: [...reasons.values()].filter((n) => n >= 2).length, note: "reasons seen twice or more" };
  };
  const firstPassGreen = (i: Inputs) => {
    const withRuns = [...i.repo.changes.values()].filter((f) => f.runs.some((r) => inWindow(r.startedAt, i.window)));
    if (withRuns.length === 0) return { value: null, note: "no per-change runs in window" };
    const green = withRuns.filter((f) => f.runs.find((r) => r.n === 1)?.verdict === "green").length;
    return { value: Math.round((green / withRuns.length) * 100), note: `${green} of ${withRuns.length} changes` };
  };
  const evalPass = (i: Inputs) => {
    const runs = i.repo.evalRuns.filter((r) => inWindow(r.startedAt, i.window) && r.verdict !== "incomplete");
    const last = runs.at(-1);
    return { value: last ? Math.round(last.passRate * 100) : null, note: last ? `latest of ${runs.length} suite run${runs.length === 1 ? "" : "s"}` : "no suite runs in window" };
  };
  const changeFailure = (i: Inputs) => {
    const merged = i.events.filter((e) => e.event === "pr.merged" && inWindow(e.ts, i.window));
    if (merged.length === 0) return { value: null, note: "no merges in window" };
    const failed = new Set(eventsNamed(i.events, "artifact.committed").filter((e) => inWindow(e.ts, i.window) && e.data.artifact === 5).map((e) => e.data.path)).size;
    return { value: Math.round((failed / merged.length) * 100), note: `${failed} incident${failed === 1 ? "" : "s"} over ${merged.length} merge${merged.length === 1 ? "" : "s"}` };
  };
  const prLatency = (i: Inputs) => {
    const hours: number[] = [];
    for (const f of i.repo.changes.values()) {
      if (f.pr?.mergedAt && inWindow(f.pr.mergedAt, i.window)) hours.push((Date.parse(f.pr.mergedAt) - Date.parse(f.pr.openedAt)) / HOUR);
    }
    const md = median(hours);
    return { value: md, note: md === null ? "no merges in window" : `median of ${hours.length}` };
  };
  const findingsPerPr = (i: Inputs) => {
    const prs = [...i.repo.changes.values()].map((f) => f.pr).filter((p): p is NonNullable<typeof p> => p !== null && inWindow(p.openedAt, i.window));
    if (prs.length === 0) return { value: null, note: "no PRs in window" };
    const total = prs.reduce((a, p) => a + (p.findings ? p.findings.high + p.findings.medium + p.findings.low : 0), 0);
    return { value: Math.round((total / prs.length) * 10) / 10, note: `over ${prs.length} PR${prs.length === 1 ? "" : "s"}` };
  };
  const deploys = (i: Inputs) => ({ value: [...i.repo.changes.values()].filter((f) => f.deploy && inWindow(f.deploy.at, i.window)).length, note: "deploy.yaml records" });
  const openTriage = (i: Inputs) => ({ value: i.repo.triage.filter((t) => t.data.status === "open").length, note: "open now" });
  const concernsOpen = (i: Inputs) => ({ value: [...i.repo.changes.values()].reduce((a, f) => a + (f.spec?.frontMatter.concerns.filter((c) => !c.resolved).length ?? 0), 0), note: "unresolved in committed specs" });
  const loops = count((e) => e.event === "gate.accepted" && e.data.gate === 6);

  const rows: StageMetrics[] = [
    {
      stage: 1,
      name: "Plan",
      leading: [m("intents committed", "count", "up", count((e) => e.event === "artifact.committed" && e.data.artifact === 0)), m("time to gate 1", "hours", "down", gateLatency(1, 0))],
      lagging: [m("intent send-backs", "count", "down", count((e) => e.event === "gate.sent_back" && e.data.gate === 1)), m("intent rework", "count", "down", staleDocs(0))],
    },
    {
      stage: 2,
      name: "Design",
      leading: [m("specs committed", "count", "up", count((e) => e.event === "artifact.committed" && e.data.artifact === 1)), m("time to gate 2", "hours", "down", gateLatency(2, 1))],
      lagging: [m("spec send-backs", "count", "down", count((e) => e.event === "gate.sent_back" && e.data.gate === 2)), m("concerns open", "count", "down", concernsOpen)],
    },
    {
      stage: 3,
      name: "Build",
      leading: [m("plan revisions to accept", "avg", "down", planRevs), m("CLAUDE.md size", "words", "down", claudeWords)],
      lagging: [m("plan send-backs", "count", "down", count((e) => e.event === "gate.sent_back" && e.data.gate === 3)), m("plan-sync blocks", "count", "down", count((e) => e.event === "hook.blocked" && e.data.hook === "plan-sync")), m("repeat reasons", "count", "down", repeatReasons)],
    },
    {
      stage: 4,
      name: "Test",
      leading: [m("first-pass green", "pct", "up", firstPassGreen), m("eval pass rate", "pct", "up", evalPass), na("incident → active eval", "hours", "eval case history", "down")],
      lagging: [na("review time per PR", "hours", "PR metadata", "down"), m("change failure rate", "pct", "down", changeFailure), na("regressions caught in CI vs prod", "pct", "CI", "up")],
    },
    {
      stage: 5,
      name: "Deploy",
      leading: [m("PR open → merge", "hours", "down", prLatency), m("findings per PR", "avg", "down", findingsPerPr)],
      lagging: [m("deploys", "count", "up", deploys), m("merge send-backs", "count", "down", count((e) => e.event === "gate.sent_back" && e.data.gate === 5))],
    },
    {
      stage: 6,
      name: "Maintain",
      leading: [m("open triage", "count", "down", openTriage), na("breached bands", "count", "detection snapshots", "down")],
      lagging: [m("incidents recorded", "count", "down", count((e) => e.event === "artifact.committed" && e.data.artifact === 5)), m("loops closed", "count", "up", loops)],
    },
  ];
  return rows.map((r) => ({ ...r, name: STAGES[r.stage - 1]?.name ?? r.name }));
}

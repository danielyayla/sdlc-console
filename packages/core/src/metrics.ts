import type { Event } from "@sdlc/schemas";
import type { ChangeView } from "./derive.js";
import { eventsNamed } from "./events.js";
import { EMPTY_SOURCES, SOURCE_NAMES, type MetricSources } from "./metricSources.js";
import type { Repo } from "./repo.js";
import { STAGES, type StageNumber } from "./stages.js";

export type Trend = "up" | "flat" | "down" | null;

/** Where a metric's numbers come from (FR-70: definitions are code with source declarations). */
export type MetricSource = "git" | "ledger" | "pr" | "ci" | "incidents" | "evals";

export interface MetricValue {
  key: string;
  name: string;
  /** null = not computable from the available sources. */
  value: number | null;
  unit: "count" | "hours" | "pct" | "words" | "avg";
  /** Shown beside the value: sample size, or "n/a · needs <source>". */
  note: string;
  trend: Trend;
  /** Value over the previous window, for the chip's tooltip. */
  previous: number | null;
  /** Change vs the previous window in percent (rounded); null when there is no previous value to compare with. */
  delta: number | null;
  /** Which direction is an improvement, for colouring the trend chip. */
  better: "up" | "down";
  sources: MetricSource[];
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
  /** External facts (PR metadata, CI, incident records); absent feeds make their metrics "n/a · needs <source>". Defaults to nothing. */
  sources?: MetricSources;
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

const pct = (part: number, whole: number): number => Math.round((part / whole) * 100);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function trendOf(current: number | null, previous: number | null): { trend: Trend; delta: number | null } {
  if (current === null || previous === null) return { trend: null, delta: null };
  if (previous === 0 && current === 0) return { trend: "flat", delta: 0 };
  if (previous === 0) return { trend: "up", delta: null };
  const ratio = (current - previous) / Math.abs(previous);
  const delta = Math.round(ratio * 100);
  return { trend: ratio > 0.05 ? "up" : ratio < -0.05 ? "down" : "flat", delta };
}

interface Window {
  from: number;
  to: number;
}

function inWindow(ts: string | null | undefined, w: Window): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  return t >= w.from && t < w.to;
}

interface Inputs {
  repo: Repo;
  views: readonly ChangeView[];
  events: Event[];
  sources: MetricSources;
  window: Window;
}

type Computer = (i: Inputs) => { value: number | null; note: string };

interface MetricDef {
  key: string;
  name: string;
  unit: MetricValue["unit"];
  better: "up" | "down";
  sources: MetricSource[];
  compute: Computer;
}

function count(pred: (e: Event) => boolean): Computer {
  return (i) => {
    const n = i.events.filter((e) => inWindow(e.ts, i.window) && pred(e)).length;
    return { value: n, note: `${i.window.to - i.window.from === 30 * DAY ? "30-day" : `${Math.round((i.window.to - i.window.from) / DAY)}-day`} window` };
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

/** A metric over an external feed: "n/a · needs <source>" while the feed is absent. */
function fed(feeds: ("pr" | "ci" | "incidents")[], compute: Computer): Computer {
  return (i) => {
    const missing = feeds.find((f) => i.sources[f] === null);
    if (missing) return { value: null, note: `n/a · needs ${SOURCE_NAMES[missing]}` };
    return compute(i);
  };
}

const staleDocs = (index: 0 | 1 | 2): Computer => (i) => ({ value: i.views.filter((v) => v.docs[index].state === "stale").length, note: "artifacts edited after acceptance" });

const claudeWords: Computer = (i) => ({ value: i.repo.claudeMd?.wordCount ?? null, note: i.repo.claudeMd ? (i.repo.claudeMd.overOnePage ? "over one page" : "under one page") : "n/a · needs CLAUDE.md" });

const planRevs: Computer = (i) => {
  const revs = i.views.filter((v) => v.planState === "committed").map((v) => v.planRev);
  return { value: revs.length ? Math.round((revs.reduce((a, b) => a + b, 0) / revs.length) * 10) / 10 : null, note: revs.length ? `avg over ${revs.length} accepted plans` : "no accepted plans" };
};

const repeatReasons: Computer = (i) => {
  const reasons = new Map<string, number>();
  for (const e of i.events) {
    if (!inWindow(e.ts, i.window)) continue;
    const r = e.event === "hook.blocked" ? e.data.reason : e.event === "gate.sent_back" ? e.data.feedback : null;
    if (r) reasons.set(r.trim().toLowerCase(), (reasons.get(r.trim().toLowerCase()) ?? 0) + 1);
  }
  return { value: [...reasons.values()].filter((n) => n >= 2).length, note: "reasons seen twice or more" };
};

const firstPassGreen: Computer = (i) => {
  const withRuns = [...i.repo.changes.values()].filter((f) => f.runs.some((r) => inWindow(r.startedAt, i.window)));
  if (withRuns.length === 0) return { value: null, note: "no per-change runs in window" };
  const green = withRuns.filter((f) => f.runs.find((r) => r.n === 1)?.verdict === "green").length;
  return { value: pct(green, withRuns.length), note: `${green} of ${withRuns.length} changes` };
};

/** Agent PRs whose opening head passed CI at the first verdict. */
const firstPassCi: Computer = fed(["pr", "ci"], (i) => {
  const prs = (i.sources.pr ?? []).filter((p) => p.agentAuthored && inWindow(p.openedAt, i.window));
  const judged = prs.map((p) => (i.sources.ci ?? []).filter((c) => c.headSha === p.openedHeadSha && c.verdict !== "pending").sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0] ?? null).filter((c) => c !== null);
  if (judged.length === 0) return { value: null, note: prs.length ? `${plural(prs.length, "agent PR")} without a CI verdict` : "no agent PRs in window" };
  const passed = judged.filter((c) => c.verdict === "pass").length;
  return { value: pct(passed, judged.length), note: `${passed} of ${plural(judged.length, "agent PR")}` };
});

const evalPass: Computer = (i) => {
  const runs = i.repo.evalRuns.filter((r) => inWindow(r.startedAt, i.window) && r.verdict !== "incomplete");
  const last = runs.at(-1);
  return { value: last ? Math.round(last.passRate * 100) : null, note: last ? `latest of ${plural(runs.length, "suite run")}` : "no suite runs in window" };
};

/** Incident-sourced eval cases: hours from the incident to the first complete suite run that exercised the case. */
const incidentToActiveEval: Computer = fed(["incidents"], (i) => {
  const cases = i.repo.evalCases.filter((c) => c.source.type === "incident");
  if (cases.length === 0) return { value: null, note: "no incident-sourced cases" };
  const hours: number[] = [];
  let waiting = 0;
  for (const c of cases) {
    const incident = (i.sources.incidents ?? []).find((f) => f.changeId === c.source.ref || f.id === c.source.ref) ?? null;
    const first = i.repo.evalRuns.find((r) => r.verdict !== "incomplete" && r.results.some((x) => x.caseId === c.id)) ?? null;
    if (!incident) continue;
    if (!first) {
      if (inWindow(c.added, i.window)) waiting++;
      continue;
    }
    if (inWindow(first.startedAt, i.window)) hours.push((Date.parse(first.startedAt) - Date.parse(incident.createdAt)) / HOUR);
  }
  const m = median(hours);
  if (m === null) return { value: null, note: waiting ? `${plural(waiting, "case")} not yet in a suite run` : "none activated in window" };
  return { value: m, note: `median of ${hours.length}${waiting ? ` · ${waiting} waiting` : ""}` };
});

/** Hours from the code PR opening to its first review — a human review when GitHub facts are cached, else the review job. */
const reviewTime: Computer = fed(["pr"], (i) => {
  const reviewed = (i.sources.pr ?? []).filter((p) => p.firstReviewAt !== null && inWindow(p.firstReviewAt, i.window));
  const hours = reviewed.map((p) => (Date.parse(p.firstReviewAt ?? "") - Date.parse(p.openedAt)) / HOUR).filter((h) => h >= 0);
  const m = median(hours);
  if (m === null) return { value: null, note: "no reviewed PRs in window" };
  const human = reviewed.filter((p) => p.reviewedBy === "human").length;
  return { value: m, note: `median of ${hours.length} · ${human === hours.length ? "human reviews" : human === 0 ? "review job" : `${human} human, ${hours.length - human} review job`}` };
});

/** Incidents attributed to changes merged in the window, over those merges. */
const changeFailure: Computer = fed(["incidents"], (i) => {
  const merged = [...i.repo.changes.values()].filter((f) => eventsNamed(f.events, "pr.merged").some((e) => inWindow(e.ts, i.window)));
  if (merged.length === 0) return { value: null, note: "no merges in window" };
  const failed = merged.filter((f) => (i.sources.incidents ?? []).some((inc) => inc.changeId === f.id)).length;
  return { value: pct(failed, merged.length), note: `${plural(failed, "incident")} over ${plural(merged.length, "merge")}` };
});

/** Share of regressions CI caught before production: failed CI heads vs incidents. */
const regressionsCaught: Computer = fed(["ci", "incidents"], (i) => {
  const inCi = new Set((i.sources.ci ?? []).filter((c) => c.verdict === "fail" && inWindow(c.startedAt, i.window)).map((c) => c.headSha)).size;
  const inProd = (i.sources.incidents ?? []).filter((f) => inWindow(f.createdAt, i.window)).length;
  if (inCi + inProd === 0) return { value: null, note: "no regressions in window" };
  return { value: pct(inCi, inCi + inProd), note: `${inCi} in CI · ${inProd} in production` };
});

const prLatency: Computer = fed(["pr"], (i) => {
  const merged = (i.sources.pr ?? []).filter((p) => inWindow(p.mergedAt, i.window));
  const md = median(merged.map((p) => (Date.parse(p.mergedAt ?? "") - Date.parse(p.openedAt)) / HOUR));
  return { value: md, note: md === null ? "no merges in window" : `median of ${merged.length}` };
});

const findingsPerPr: Computer = (i) => {
  const prs = [...i.repo.changes.values()].map((f) => f.pr).filter((p): p is NonNullable<typeof p> => p !== null && inWindow(p.openedAt, i.window));
  if (prs.length === 0) return { value: null, note: "no PRs in window" };
  const total = prs.reduce((a, p) => a + (p.findings ? p.findings.high + p.findings.medium + p.findings.low : 0), 0);
  return { value: Math.round((total / prs.length) * 10) / 10, note: `over ${plural(prs.length, "PR")}` };
};

const deploys: Computer = (i) => ({ value: [...i.repo.changes.values()].filter((f) => f.deploy && inWindow(f.deploy.at, i.window)).length, note: "deploy.yaml records" });

const deployFailures: Computer = (i) => {
  const records = [...i.repo.changes.values()].filter((f) => f.deploy && inWindow(f.deploy.at, i.window) && (f.deploy.status === "failed" || f.deploy.status === "rolled_back")).length;
  const events = i.events.filter((e) => e.event === "deploy.failed" && inWindow(e.ts, i.window)).length;
  return { value: Math.max(records, events), note: `${plural(records, "record")} failed or rolled back · ${plural(events, "deploy.failed event")}` };
};

const openTriage: Computer = (i) => ({ value: i.repo.triage.filter((t) => t.data.status === "open").length, note: "open now" });

const concernsOpen: Computer = (i) => ({ value: [...i.repo.changes.values()].reduce((a, f) => a + (f.spec?.frontMatter.concerns.filter((c) => !c.resolved).length ?? 0), 0), note: "unresolved in committed specs" });

const incidentsRecorded: Computer = fed(["incidents"], (i) => {
  const inc = (i.sources.incidents ?? []).filter((f) => inWindow(f.createdAt, i.window));
  const files = inc.filter((f) => f.origin === "incident.md").length;
  return { value: inc.length, note: `${files} incident.md · ${inc.length - files} triage` };
});

/** Hours from an incident to the merge of its fix. */
const incidentToFix: Computer = fed(["incidents"], (i) => {
  const all = i.sources.incidents ?? [];
  const fixed = all.filter((f) => inWindow(f.fixedAt, i.window));
  const open = all.filter((f) => f.fixedAt === null && inWindow(f.createdAt, i.window)).length;
  const m = median(fixed.map((f) => (Date.parse(f.fixedAt ?? "") - Date.parse(f.createdAt)) / HOUR));
  if (m === null) return { value: null, note: open ? `${plural(open, "incident")} open, none fixed in window` : "none fixed in window" };
  return { value: m, note: `median of ${fixed.length}${open ? ` · ${open} open` : ""}` };
});

const loops: Computer = count((e) => e.event === "gate.accepted" && e.data.gate === 6);

const na = (key: string, name: string, unit: MetricValue["unit"], better: "up" | "down", source: string): MetricDef => ({ key, name, unit, better, sources: [], compute: () => ({ value: null, note: `n/a · needs ${source}` }) });

const def = (key: string, name: string, unit: MetricValue["unit"], better: "up" | "down", sources: MetricSource[], compute: Computer): MetricDef => ({ key, name, unit, better, sources, compute });

/** The catalogue: per stage, leading and lagging (playbook "how to measure"; spec §4.8, 5B.6). */
export const METRIC_CATALOGUE: readonly { stage: StageNumber; leading: MetricDef[]; lagging: MetricDef[] }[] = [
  {
    stage: 1,
    leading: [def("intents_committed", "intents committed", "count", "up", ["ledger"], count((e) => e.event === "artifact.committed" && e.data.artifact === 0)), def("time_to_gate_1", "time to gate 1", "hours", "down", ["ledger"], gateLatency(1, 0))],
    lagging: [def("intent_send_backs", "intent send-backs", "count", "down", ["ledger"], count((e) => e.event === "gate.sent_back" && e.data.gate === 1)), def("intent_rework", "intent rework", "count", "down", ["git"], staleDocs(0))],
  },
  {
    stage: 2,
    leading: [def("specs_committed", "specs committed", "count", "up", ["ledger"], count((e) => e.event === "artifact.committed" && e.data.artifact === 1)), def("time_to_gate_2", "time to gate 2", "hours", "down", ["ledger"], gateLatency(2, 1))],
    lagging: [def("spec_send_backs", "spec send-backs", "count", "down", ["ledger"], count((e) => e.event === "gate.sent_back" && e.data.gate === 2)), def("concerns_open", "concerns open", "count", "down", ["git"], concernsOpen)],
  },
  {
    stage: 3,
    leading: [def("plan_revisions", "plan revisions to accept", "avg", "down", ["git", "ledger"], planRevs), def("claude_md_size", "CLAUDE.md size", "words", "down", ["git"], claudeWords)],
    lagging: [
      def("plan_send_backs", "plan send-backs", "count", "down", ["ledger"], count((e) => e.event === "gate.sent_back" && e.data.gate === 3)),
      def("plan_sync_blocks", "plan-sync blocks", "count", "down", ["ledger"], count((e) => e.event === "hook.blocked" && e.data.hook === "plan-sync")),
      def("repeat_reasons", "repeat reasons", "count", "down", ["ledger"], repeatReasons),
    ],
  },
  {
    stage: 4,
    leading: [
      def("first_pass_green", "first-pass green", "pct", "up", ["git"], firstPassGreen),
      def("first_pass_ci", "first-pass CI (agent PRs)", "pct", "up", ["pr", "ci"], firstPassCi),
      def("eval_pass_rate", "eval pass rate", "pct", "up", ["evals"], evalPass),
      def("incident_to_active_eval", "incident → active eval", "hours", "down", ["incidents", "evals"], incidentToActiveEval),
    ],
    lagging: [
      def("review_time", "review time per PR", "hours", "down", ["pr"], reviewTime),
      def("change_failure_rate", "change failure rate", "pct", "down", ["ledger", "incidents"], changeFailure),
      def("regressions_caught", "regressions caught in CI vs prod", "pct", "up", ["ci", "incidents"], regressionsCaught),
    ],
  },
  {
    stage: 5,
    leading: [def("pr_open_to_merge", "PR open → merge", "hours", "down", ["pr"], prLatency), def("findings_per_pr", "findings per PR", "avg", "down", ["git"], findingsPerPr)],
    lagging: [
      def("deploys", "deploys", "count", "up", ["git"], deploys),
      def("deploy_failures", "deploy failures", "count", "down", ["git", "ledger"], deployFailures),
      def("merge_send_backs", "merge send-backs", "count", "down", ["ledger"], count((e) => e.event === "gate.sent_back" && e.data.gate === 5)),
    ],
  },
  {
    stage: 6,
    leading: [def("open_triage", "open triage", "count", "down", ["git"], openTriage), na("breached_bands", "breached bands", "count", "down", "detection snapshots")],
    lagging: [def("incidents_recorded", "incidents recorded", "count", "down", ["incidents"], incidentsRecorded), def("incident_to_fix", "incident → fix merged", "hours", "down", ["incidents", "ledger"], incidentToFix), def("loops_closed", "loops closed", "count", "up", ["ledger"], loops)],
  },
];

function evaluate(d: MetricDef, inputs: Inputs, previous: Inputs): MetricValue {
  const cur = d.compute(inputs);
  const prev = d.compute(previous);
  const t = trendOf(cur.value, prev.value);
  return { key: d.key, name: d.name, value: cur.value, unit: d.unit, note: cur.note, trend: t.trend, previous: prev.value, delta: t.delta, better: d.better, sources: d.sources };
}

/** Per-stage leading/lagging metrics over git, the ledger and the external feeds (FR-70, decisions Q13). */
export function computeMetrics(repo: Repo, views: readonly ChangeView[], opts: MetricsOptions): StageMetrics[] {
  const days = opts.windowDays ?? 30;
  const to = Date.parse(opts.now);
  const cur: Window = { from: to - days * DAY, to };
  const prev: Window = { from: cur.from - days * DAY, to: cur.from };
  const events = [...repo.changes.values()].flatMap((f) => f.events);
  const sources = opts.sources ?? EMPTY_SOURCES;
  const inputs: Inputs = { repo, views, events, sources, window: cur };
  const previous: Inputs = { repo, views, events, sources, window: prev };
  return METRIC_CATALOGUE.map((s) => ({
    stage: s.stage,
    name: STAGES[s.stage - 1]?.name ?? String(s.stage),
    leading: s.leading.map((d) => evaluate(d, inputs, previous)),
    lagging: s.lagging.map((d) => evaluate(d, inputs, previous)),
  }));
}

/** `7d`, `30d`, `90d` → days; anything else is refused. */
export function parseWindow(text: string | undefined): number | null {
  if (text === undefined || text === "") return 30;
  const m = /^(\d{1,3})d$/.exec(text.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
}

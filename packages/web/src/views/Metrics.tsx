import type { MetricValue, StageMetrics } from "@sdlc/core";
import type { MetricSourcesStatus, SourceStatus } from "@sdlc/server";

function fmt(v: MetricValue): string {
  if (v.value === null) return "n/a";
  switch (v.unit) {
    case "pct":
      return `${v.value}%`;
    case "hours":
      return v.value >= 48 ? `${Math.round(v.value / 24)}d` : `${v.value}h`;
    default:
      return String(v.value);
  }
}

function fmtPrev(v: MetricValue): string {
  if (v.previous === null) return "no previous window";
  const p = { ...v, value: v.previous };
  return `previous window: ${fmt(p)}`;
}

/** ▲ green / — gray / ▼ amber (spec §4.8) with the % change against the previous window. */
function TrendChip({ v }: { v: MetricValue }) {
  if (v.trend === null || v.trend === "flat") return <span className="chip gray" title={fmtPrev(v)}>—{v.trend === "flat" && v.delta !== null && v.delta !== 0 ? ` ${v.delta > 0 ? "+" : ""}${v.delta}%` : ""}</span>;
  const good = v.trend === v.better;
  const delta = v.delta === null ? "" : ` ${v.delta > 0 ? "+" : ""}${v.delta}%`;
  return <span className={`chip ${good ? "green" : "amber"}`} title={fmtPrev(v)}>{v.trend === "up" ? "▲" : "▼"}{delta}</span>;
}

function Half({ label, values }: { label: string; values: MetricValue[] }) {
  return (
    <div className="half">
      <div className="eyebrow">{label}</div>
      {values.map((v) => (
        <div className="metric" key={v.key}>
          <div className="metric-head"><span className="metric-name">{v.name}</span><span className="metric-sources">{v.sources.join(" · ")}</span><TrendChip v={v} /></div>
          <div className="metric-value">{fmt(v)}</div>
          <div className="metric-note">{v.note}</div>
        </div>
      ))}
    </div>
  );
}

const FEEDS: { key: keyof MetricSourcesStatus; label: string }[] = [
  { key: "pr", label: "PR metadata" },
  { key: "ci", label: "CI" },
  { key: "incidents", label: "incident records" },
];

function via(s: SourceStatus): string {
  if (s.via === "none") return "none";
  if (s.via === "github") return `GitHub${s.fetchedAt ? ` · fetched ${s.fetchedAt.replace("T", " ").replace(/:\d\dZ$/, "")}` : ""}`;
  return "git mirror";
}

export function Metrics({ metrics, sources }: { metrics: StageMetrics[]; sources?: MetricSourcesStatus }) {
  return (
    <div className="metrics">
      {sources ? (
        <div className="metrics-sources">
          <span className="eyebrow">Sources</span>
          {FEEDS.map((f) => (
            <span key={f.key} className={`chip ${sources[f.key].via === "none" ? "amber" : "gray"}`}>{f.label} · {via(sources[f.key])}</span>
          ))}
          <span className="muted">30-day window vs the 30 days before</span>
        </div>
      ) : null}
      {metrics.map((s) => (
        <section className="panel" key={s.stage}>
          <div className="column-head"><span className="column-num">{String(s.stage).padStart(2, "0")}</span><span>{s.name}</span><span className="column-count">30 days</span></div>
          <div className="halves">
            <Half label="Leading" values={s.leading} />
            <Half label="Lagging" values={s.lagging} />
          </div>
        </section>
      ))}
    </div>
  );
}

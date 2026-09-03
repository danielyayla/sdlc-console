import type { MetricValue, StageMetrics } from "@sdlc/core";

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

function TrendChip({ v }: { v: MetricValue }) {
  if (v.trend === null) return <span className="chip gray">—</span>;
  if (v.trend === "flat") return <span className="chip gray">—</span>;
  const good = v.trend === v.better;
  return <span className={`chip ${good ? "green" : "amber"}`}>{v.trend === "up" ? "▲" : "▼"}</span>;
}

function Half({ label, values }: { label: string; values: MetricValue[] }) {
  return (
    <div className="half">
      <div className="eyebrow">{label}</div>
      {values.map((v) => (
        <div className="metric" key={v.name}>
          <div className="metric-head"><span className="metric-name">{v.name}</span><TrendChip v={v} /></div>
          <div className="metric-value">{fmt(v)}</div>
          <div className="metric-note">{v.note}</div>
        </div>
      ))}
    </div>
  );
}

export function Metrics({ metrics }: { metrics: StageMetrics[] }) {
  return (
    <div className="metrics">
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

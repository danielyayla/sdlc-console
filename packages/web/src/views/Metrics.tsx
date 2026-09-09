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

/** The trend as a glyph in its state colour (handoff, C10): ▲/▼ with the % change, green when it moved the better way, amber when not; — when flat or unknown. The previous window stays in the title. */
function Trend({ v }: { v: MetricValue }) {
  if (v.trend === null || v.trend === "flat") return <span className="trend mono faint" title={fmtPrev(v)}>—</span>;
  const good = v.trend === v.better;
  const delta = v.delta === null ? "" : ` ${v.delta > 0 ? "+" : ""}${v.delta}%`;
  return <span className={`trend mono ${good ? "green-text" : "amber-text"}`} title={fmtPrev(v)}>{v.trend === "up" ? "▲" : "▼"}{delta}</span>;
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
      <div className="primary">Metrics</div>
      <div className="mono faint view-sub msub">
        <span>30-day window vs the 30 before</span>
        {sources ? FEEDS.map((f) => <span key={f.key} className={sources[f.key].via === "none" ? "amber-text" : ""}>{f.label} · {via(sources[f.key])}</span>) : null}
      </div>
      <div className="mgrid">
        {metrics.map((s) => (
          <section className="mstage" key={s.stage} aria-label={`${s.stage} ${s.name}`}>
            <div className="mstage-head mono">{String(s.stage).padStart(2, "0")} {s.name}</div>
            {[...s.leading.map((v) => ({ v, kind: "leading" })), ...s.lagging.map((v) => ({ v, kind: "lagging" }))].map(({ v, kind }) => (
              <div className="mrow" key={v.key}>
                <div className="mvalue-row"><span className="mvalue tabular">{fmt(v)}</span><Trend v={v} /><span className="mkind mono">{kind}</span></div>
                <div className="mname">{v.name}</div>
                <div className="mono faint">{v.note} · {v.sources.join(" · ")}</div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

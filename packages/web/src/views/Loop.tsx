import type { Snapshot } from "@sdlc/server";

export interface LoopProps {
  snapshot: Snapshot;
  onAccept: (id: string) => void;
  onDismiss: (id: string, reason: string, tune: string) => void;
  prompt?: (text: string) => string | null;
}

export function Loop({ snapshot, onAccept, onDismiss, prompt = (t) => window.prompt(t) }: LoopProps) {
  const open = snapshot.triage.filter((t) => t.data.status === "open");
  const bands = snapshot.bands?.metrics ?? [];
  return (
    <div className="loop">
      <table className="bands">
        <thead>
          <tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Tier</th><th>Action</th><th>Status</th></tr>
        </thead>
        <tbody>
          {bands.length === 0 ? <tr><td colSpan={6} className="empty">no bands.yaml</td></tr> : null}
          {bands.map((b) => (
            <tr key={b.metric}>
              <td className="mono">{b.metric}</td>
              <td className="num">{b.baseline}{b.unit ? ` ${b.unit}` : ""}</td>
              <td className="num muted">no data</td>
              <td className="mono">—</td>
              <td>{b.tiers["1sigma"].action} / {b.tiers["2sigma"].action} / {b.tiers["3sigma"].action}</td>
              <td className="muted">no data · needs detection snapshots</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="footer">bands.yaml · rolling {snapshot.bands?.baselineWindow ?? "30d"} baseline · Western Electric rules · 1σ log, 2σ diagnose read-only, 3σ propose via PR or pre-approved runbook.</div>

      <h2 className="eyebrow">Triage queue · {open.length}</h2>
      {open.length === 0 ? <div className="empty">Queue clear — the loop is feeding itself.</div> : null}
      {open.map((t) => (
        <article className="tcard" key={t.data.id}>
          <div className="card-head">
            <span className="id">{t.data.id}</span>
            <span className={`chip ${t.data.tier === "incident" ? "red" : "amber"}`}>{t.data.tier}</span>
            <span className="mono muted">{t.data.src}</span>
          </div>
          <div className="card-title">{t.data.title}</div>
          <div className="card-status">{t.data.evidence}</div>
          <div className="actions">
            <button className="btn primary" onClick={() => onAccept(t.data.id)}>Accept → Plan</button>
            <button
              className="btn"
              onClick={() => {
                const reason = prompt(`Dismiss ${t.data.id} — reason (required):`);
                if (!reason || reason.trim() === "") return;
                const tune = prompt("Tune band? (optional note)") ?? "";
                onDismiss(t.data.id, reason, tune);
              }}
            >
              Dismiss · tune band
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

import type { Snapshot } from "@sdlc/server";
import type { JobRow } from "../api";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";

export interface LoopProps {
  snapshot: Snapshot;
  onAccept: (id: string) => void;
  onDismiss: (id: string, reason: string, tune: string) => void;
  /** Run a detection pass now (`POST /api/detect`); absent when the server has no engine. */
  onDetect?: (() => void) | undefined;
  /** The job queue (cache), for the diagnose/propose jobs a breach raised. */
  jobs?: JobRow[];
  /** The open inline reason form (rule 3): dismissal reason + band tune are typed under the item. */
  form: FormState;
  onForm: (form: FormState) => void;
}

function fmt(n: number | null, unit: string | null): string {
  if (n === null) return "—";
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  return unit ? `${s} ${unit}` : s;
}

/** Loop view (spec §4.6, FR-60/61): the Bands table over bands.yaml + detection snapshots, then the triage queue. */
export function Loop({ snapshot, onAccept, onDismiss, onDetect, jobs = [], form, onForm }: LoopProps) {
  const close = () => onForm(null);
  const open = snapshot.triage.filter((t) => t.data.status === "open");
  const bands = snapshot.bands?.metrics ?? [];
  const rows = snapshot.bandStatus ?? [];
  const latest = rows.map((r) => r.ts).filter((t): t is string => t !== null).sort().at(-1) ?? null;
  const bandJobs = (metric: string) => jobs.filter((j) => j.key.startsWith(`band:${metric}:`));
  const jobFor = (key: string | null) => (key ? jobs.find((j) => j.key === key) ?? null : null);
  const runbooks = snapshot.bands?.runbooks ?? [];
  return (
    <div className="loop">
      <table className="bands">
        <thead>
          <tr><th>Metric</th><th>Baseline</th><th>Current</th><th>σ</th><th>Tier</th><th>Action</th><th>Status</th></tr>
        </thead>
        <tbody>
          {bands.length === 0 ? <tr><td colSpan={7} className="empty">no bands.yaml</td></tr> : null}
          {bands.map((b) => {
            const s = rows.find((r) => r.metric === b.metric);
            const breached = s?.breached ?? false;
            const raised = bandJobs(b.metric);
            const live = raised.find((j) => j.state === "running") ?? raised[0] ?? null;
            return (
              <tr key={b.metric} className={breached ? "breached" : s?.tier === 1 ? "warned" : ""}>
                <td className="mono">{b.metric}</td>
                <td className="num">{fmt(b.baseline, b.unit ?? null)}</td>
                <td className={`num${s?.current === null || s === undefined ? " muted" : ""}`}>{s ? fmt(s.current, b.unit ?? null) : "no data"}</td>
                <td className="num muted">{s?.sigma === null || s === undefined ? "—" : fmt(s.sigma, null)}</td>
                <td className="mono">{s?.tier === null || s === undefined ? "—" : <span className={`chip ${s.tier >= 2 ? "amber" : ""}`}>{s.tier}σ</span>}</td>
                <td>{b.tiers["1sigma"].action} / {b.tiers["2sigma"].action} / {b.tiers["3sigma"].action}</td>
                <td className={breached ? "" : "muted"}>
                  {s?.status ?? "no data · needs detection snapshots"}
                  {s?.triage.map((id) => <span key={id} className="chip amber linkchip" title="open triage item">{id}</span>)}
                  {live ? <span className="chip" title={live.key}>{live.kind} {live.state}{live.sessionId ? ` · ${live.sessionId}` : ""}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="footer">
        bands.yaml · rolling {snapshot.bands?.baselineWindow ?? "30d"} baseline · Western Electric rules · 1σ log, 2σ diagnose read-only, 3σ propose via PR or pre-approved runbook.
        {" "}detection {snapshot.bands?.detectEvery ? `every ${snapshot.bands.detectEvery}` : "every 15m"} · last snapshot {latest ?? "never"}
        {runbooks.length > 0 ? ` · runbooks: ${runbooks.map((r) => (typeof r === "string" ? `${r} (no command)` : r.id)).join(", ")}` : ""}
        {onDetect ? <button className="btn" onClick={onDetect} title="run the detection script now">Run detection</button> : null}
      </div>

      <h2 className="eyebrow">Triage queue · {open.length}</h2>
      {open.length === 0 ? <div className="empty">Queue clear — the loop is feeding itself.</div> : null}
      {open.map((t) => {
        const job = jobFor(t.data.job ?? null);
        const runs = (snapshot.runbookRuns ?? []).filter((r) => r.triage === t.data.id);
        return (
          <article className="tcard" key={t.data.id}>
            <div className="card-head">
              <span className="id">{t.data.id}</span>
              <span className={`chip ${t.data.tier === "incident" ? "red" : "amber"}`}>{t.data.tier}</span>
              <span className="mono muted">{t.data.src}</span>
              {t.data.job ? <span className="chip" title={t.data.job}>{job ? `${job.kind} ${job.state}` : "job"}{job?.sessionId ? ` · ${job.sessionId}` : t.data.session ? ` · ${t.data.session}` : ""}</span> : null}
              {t.data.channel ? <span className="mono muted" title={`message ${t.data.channel.messageId}`}>{t.data.channel.author} · <a href={t.data.channel.permalink} target="_blank" rel="noreferrer">message</a>{t.data.channel.postedAt ? ` · ${t.data.channel.postedAt}` : ""}</span> : null}
            </div>
            <div className="card-title">{t.data.title}</div>
            {t.data.channel?.tags && t.data.channel.tags.length > 0 ? <div className="card-status">{t.data.channel.tags.map((tag) => <span className="chip gray" key={tag}>{tag}</span>)}</div> : null}
            <pre className="evidence">{t.data.evidence}</pre>
            {runs.length > 0 ? <div className="card-status">runbooks: {runs.map((r) => `${r.id} ${r.runbook} (exit ${r.exitCode})`).join(" · ")}</div> : null}
            <div className="actions">
              <button className="btn primary" onClick={() => onAccept(t.data.id)}>Accept → Plan</button>
              <button className="btn" onClick={() => onForm({ kind: "dismiss-triage", id: t.data.id })}>
                Dismiss · tune band
              </button>
            </div>
            {formOpen(form, "dismiss-triage", t.data.id) ? <InlineReason placeholder="" submitLabel="Dismiss · tune band" fields={[{ key: "reason", placeholder: `Why ${t.data.id} is dismissed — required` }, { key: "tune", placeholder: "Tune the band? — optional note", required: false }]} onCancel={close} onSubmit={(v) => { close(); onDismiss(t.data.id, v["reason"] ?? "", v["tune"] ?? ""); }} /> : null}
          </article>
        );
      })}
    </div>
  );
}

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

/** Loop view (spec §4.6, FR-60/61): the triage queue is the primary object, then the bands over bands.yaml + detection snapshots. */
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
      <div className="primary">{open.length === 0 ? "Queue clear — the loop is feeding itself." : open.length === 1 ? "1 signal in the triage queue." : `${open.length} signals in the triage queue.`}</div>
      <div className="items">
      {open.map((t) => {
        const job = jobFor(t.data.job ?? null);
        const runs = (snapshot.runbookRuns ?? []).filter((r) => r.triage === t.data.id);
        return (
          <article className={`item edge-lit ${t.data.tier === "incident" ? "red" : "amber"}`} key={t.data.id}>
            <div className="item-meta mono">
              <span className="muted">{t.data.id}</span>
              <span className={t.data.tier === "incident" ? "red-text" : "amber-text"}>{t.data.tier}</span>
              <span>{t.data.src}</span>
              {t.data.job ? <span title={t.data.job}>{job ? `${job.kind} ${job.state}` : "job"}{job?.sessionId ? ` · ${job.sessionId}` : t.data.session ? ` · ${t.data.session}` : ""}</span> : null}
              {t.data.channel ? <span title={`message ${t.data.channel.messageId}`}>{t.data.channel.author} · <a href={t.data.channel.permalink} target="_blank" rel="noreferrer">message</a>{t.data.channel.postedAt ? ` · ${t.data.channel.postedAt}` : ""}</span> : null}
              {t.data.channel?.tags?.map((tag) => <span className="faint" key={tag}>{tag}</span>)}
              <span className="when">{t.data.createdAt}</span>
            </div>
            <div className="item-title">{t.data.title}</div>
            <pre className="evidence">{t.data.evidence}</pre>
            {runs.length > 0 ? <div className="item-line mono">runbooks: {runs.map((r) => `${r.id} ${r.runbook} (exit ${r.exitCode})`).join(" · ")}</div> : null}
            <div className="actions">
              <button className="btn primary" onClick={() => onAccept(t.data.id)}>Accept → Plan</button>
              {formOpen(form, "dismiss-triage", t.data.id) ? null : <button className="btn text" onClick={() => onForm({ kind: "dismiss-triage", id: t.data.id })}>Dismiss · tune band</button>}
            </div>
            {formOpen(form, "dismiss-triage", t.data.id) ? <InlineReason placeholder="" submitLabel="Dismiss · tune band" fields={[{ key: "reason", placeholder: `Why ${t.data.id} is dismissed — required` }, { key: "tune", placeholder: "Tune the band? — optional note", required: false }]} onCancel={close} onSubmit={(v) => { close(); onDismiss(t.data.id, v["reason"] ?? "", v["tune"] ?? ""); }} /> : null}
          </article>
        );
      })}
      </div>
      <section className="bands" aria-label="bands">
        <div className="bands-head mono">
          <span className="secondary">Bands</span>
          <span>rolling {snapshot.bands?.baselineWindow ?? "30d"} · Western Electric · detection every {snapshot.bands?.detectEvery ?? "15m"} · last {latest ?? "never"}</span>
          <span className="spacer"></span>
          {onDetect ? <button className="btn text" onClick={onDetect} title="run the detection script now">Run detection</button> : null}
        </div>
        {bands.length === 0 ? <div className="band-row mono"><span className="faint">no bands.yaml</span></div> : null}
        {bands.map((b) => {
          const s = rows.find((r) => r.metric === b.metric);
          const breached = s?.breached ?? false;
          const raised = bandJobs(b.metric);
          const live = raised.find((j) => j.state === "running") ?? raised[0] ?? null;
          return (
            <div className="band-row mono" key={b.metric}>
              <span className="secondary">{b.metric}</span>
              <span className="muted">{fmt(b.baseline, b.unit ?? null)}</span>
              <span className={breached ? "amber-text" : s && s.current !== null ? "secondary" : "faint"}>{s ? fmt(s.current, b.unit ?? null) : "no data"}</span>
              <span className="faint">{s?.sigma === null || s === undefined ? "—" : `${fmt(s.sigma, null)}σ`}</span>
              <span className={s?.tier !== null && s !== undefined && s.tier >= 2 ? "amber-text" : "faint"}>{s?.tier === null || s === undefined ? "—" : `${s.tier}σ`}</span>
              <span className={breached ? "" : "muted"}>
                {s?.status ?? "no data · needs detection snapshots"}
                {s?.triage.map((id) => <span key={id} className="mono amber-text word" title="open triage item">{id}</span>)}
                {live ? <span className="mono faint word" title={live.key}>{live.kind} {live.state}{live.sessionId ? ` · ${live.sessionId}` : ""}</span> : null}
              </span>
            </div>
          );
        })}
      </section>
      <div className="footer mono">
        1σ log, 2σ diagnose read-only, 3σ propose via PR or pre-approved runbook.
        {runbooks.length > 0 ? ` · runbooks: ${runbooks.map((r) => (typeof r === "string" ? `${r} (no command)` : r.id)).join(", ")}` : ""}
      </div>
    </div>
  );
}

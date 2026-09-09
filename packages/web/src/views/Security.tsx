import type { Snapshot } from "@sdlc/server";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";

export interface SecurityProps {
  snapshot: Snapshot;
  onPatch: (id: string) => void;
  onEscalate: (id: string) => void;
  onDismiss: (id: string, reason: string) => void;
  /** The open inline reason form (rule 3): the dismissal reason is typed under the finding. */
  form: FormState;
  onForm: (form: FormState) => void;
}

const STATUS_LABEL: Record<string, string> = { new: "new", patch_pr: "patch in PR gate", escalated: "escalated → intent", dismissed: "dismissed" };

export function Security({ snapshot, onPatch, onEscalate, onDismiss, form, onForm }: SecurityProps) {
  const close = () => onForm(null);
  const findings = snapshot.findings;
  const validated = findings.filter((f) => f.validated).length;
  const repos = new Set(findings.map((f) => f.repo)).size;
  // the last scan the intake (3.5) recorded on a finding; a CSV/MD import leaves no run behind
  const scans = findings.map((f) => f.run).filter((r): r is NonNullable<typeof r> => r !== undefined && r.at !== undefined);
  const latestScan = scans.length > 0 ? scans.reduce((a, b) => ((b.at ?? "") > (a.at ?? "") ? b : a)) : null;
  const latestRun = latestScan?.at ?? null;
  return (
    <div className="security">
      <div className="view-head">
        <h1 className="primary">Security</h1>
        <span className="mono faint">
          recurring scans · {repos} repo{repos === 1 ? "" : "s"} · last run {latestRun ? <>{latestRun}{latestScan?.url ? <> · <a href={latestScan.url} target="_blank" rel="noreferrer">{latestScan.id}</a></> : ` · ${latestScan?.id ?? ""}`}</> : "n/a · scanner not connected — POST /api/webhooks/claude-security or import a CSV/MD export"} · {validated} validated
        </span>
      </div>
      {findings.length === 0 ? <div className="empty">Nothing here</div> : null}
      <div className="items">
      {findings.map((f) => {
        const dismissed = f.status === "dismissed";
        const resolved = f.resolved !== undefined;
        const where = f.location ? `${f.location.path}${f.location.startLine ? `:${f.location.startLine}${f.location.endLine && f.location.endLine !== f.location.startLine ? `-${f.location.endLine}` : ""}` : ""}` : null;
        return (
          <article className={`item edge-lit ${dismissed || resolved ? "off dismissed" : f.sev === "high" ? "red" : f.sev === "medium" ? "amber" : "off"}`} key={f.id}>
            <div className="item-meta mono">
              <span className={f.sev === "high" ? "red-text" : f.sev === "medium" ? "amber-text" : "muted"}>{f.sev}</span>
              <span className="muted">{f.id}</span>
              {f.source ? <span title={f.scannerId}>{f.source}</span> : null}
              <span title="confidence">{f.validated ? "validated · " : ""}{f.conf.toFixed(2)}</span>
              <span className={f.status === "new" ? "amber-text" : "muted"}>{STATUS_LABEL[f.status] ?? f.status}{f.escalatedTo ? ` ${f.escalatedTo}` : ""}</span>
              {resolved ? <span className="green-text" title={`run ${f.resolved?.run ?? ""}`}>resolved by scanner · {f.resolved?.at ?? ""}</span> : null}
            </div>
            <div className="item-title">{f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.title}</a> : f.title}</div>
            <div className="item-line">{f.desc} · {f.repo}</div>
            {where || f.rule || f.cwe || f.run ? (
              <div className="item-line mono">
                {where ? <span>{where}</span> : null}
                {f.rule ? <span> · {f.rule}</span> : null}
                {f.cwe ? <span> · {f.cwe}</span> : null}
                {f.run ? <span> · run {f.run.url ? <a href={f.run.url} target="_blank" rel="noreferrer">{f.run.id}</a> : f.run.id}{f.run.at ? ` at ${f.run.at}` : ""}</span> : null}
              </div>
            ) : null}
            {f.evidence ? <pre className="evidence">{f.evidence}</pre> : null}
            {f.status === "new" && !resolved ? (
              <div className="actions">
                <button className="btn primary" onClick={() => onPatch(f.id)}>Patch → PR gate</button>
                <button className="btn text" onClick={() => onEscalate(f.id)}>Wider than one patch → intent.md</button>
                {formOpen(form, "dismiss-finding", f.id) ? null : <button className="btn text" onClick={() => onForm({ kind: "dismiss-finding", id: f.id })}>Dismiss with reason</button>}
              </div>
            ) : null}
            {f.status === "new" && !resolved && formOpen(form, "dismiss-finding", f.id) ? <InlineReason placeholder={`Why ${f.id} is dismissed — required`} submitLabel="Dismiss" onCancel={close} onSubmit={(v) => { close(); onDismiss(f.id, v["reason"] ?? ""); }} /> : null}
          </article>
        );
      })}
      </div>
      <div className="footer mono">Fixes reach production only through PR review and branch protection; the proposing agent cannot approve its own fix; deterministic checks stay in CI.</div>
    </div>
  );
}

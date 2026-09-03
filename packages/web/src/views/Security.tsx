import type { Snapshot } from "@sdlc/server";

export interface SecurityProps {
  snapshot: Snapshot;
  onPatch: (id: string) => void;
  onEscalate: (id: string) => void;
  onDismiss: (id: string, reason: string) => void;
  prompt?: (text: string) => string | null;
}

const STATUS_LABEL: Record<string, string> = { new: "new", patch_pr: "patch in PR gate", escalated: "escalated → intent", dismissed: "dismissed" };

export function Security({ snapshot, onPatch, onEscalate, onDismiss, prompt = (t) => window.prompt(t) }: SecurityProps) {
  const findings = snapshot.findings;
  const validated = findings.filter((f) => f.validated).length;
  const repos = new Set(findings.map((f) => f.repo)).size;
  const latestRun = snapshot.evalRuns.at(-1)?.startedAt ?? null;
  return (
    <div className="security">
      <div className="subhead muted">
        recurring scans · {repos} repo{repos === 1 ? "" : "s"} · last run {latestRun ?? "n/a · scanner not connected — import a CSV/MD export"} · {validated} validated
      </div>
      {findings.length === 0 ? <div className="empty">No findings on file.</div> : null}
      {findings.map((f) => {
        const dismissed = f.status === "dismissed";
        return (
          <article className={`tcard${dismissed ? " dismissed" : ""}`} key={f.id}>
            <div className="card-head">
              <span className={`chip ${f.sev === "high" ? "red" : f.sev === "medium" ? "amber" : "gray"}`}>{f.sev}</span>
              <span className="id">{f.id}</span>
              <span className="mono muted">{f.validated ? "validated · " : ""}{f.conf.toFixed(2)}</span>
              <span className="chip">{STATUS_LABEL[f.status] ?? f.status}{f.escalatedTo ? ` ${f.escalatedTo}` : ""}</span>
            </div>
            <div className="card-title">{f.title}</div>
            <div className="card-status">{f.desc} · {f.repo}</div>
            {f.status === "new" ? (
              <div className="actions">
                <button className="btn primary" onClick={() => onPatch(f.id)}>Patch → PR gate</button>
                <button className="btn" onClick={() => onEscalate(f.id)}>Wider than one patch → intent.md</button>
                <button
                  className="btn"
                  onClick={() => {
                    const reason = prompt(`Dismiss ${f.id} — reason (required):`);
                    if (reason && reason.trim() !== "") onDismiss(f.id, reason);
                  }}
                >
                  Dismiss with reason
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
      <div className="footer">Fixes reach production only through PR review and branch protection; the proposing agent cannot approve its own fix; deterministic checks stay in CI.</div>
    </div>
  );
}

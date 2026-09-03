import type { ChangeView } from "@sdlc/core";
import { useEffect, useState } from "react";
import { fetchArtifact, type Artifact } from "../api";
import { ARTIFACT_FILES, ARTIFACT_NAMES, ROLE_LABEL, STAGE_NAMES, dotClass, ownsGate, relativeTime, riskLabel, viewerState, waitingFor, type Role } from "../lib/format";

export interface ChangeDetailProps {
  view: ChangeView;
  role: Role;
  art: number | null;
  now: Date;
  /** Injected for server-side rendering tests; defaults to the HTTP fetch. */
  loadArtifact?: (id: string, index: number) => Promise<Artifact>;
  onBack: () => void;
  onSelectArt: (index: number) => void;
  onAccept: (gate: number) => void;
  onSendBack: (gate: number, feedback: string) => void;
  /** Post-merge "Add as eval": drafts a case for the platform owner. */
  onHarvest: () => void;
}

const STAGE_INDEX = [0, 1, 2, 3, 4, 5];

export function ChangeDetail(p: ChangeDetailProps) {
  const { view, role } = p;
  const selected = p.art ?? view.stage - 1;
  const doc = view.docs[selected as 0 | 1 | 2 | 3 | 4 | 5];
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const load = p.loadArtifact ?? fetchArtifact;
  useEffect(() => {
    let alive = true;
    setArtifact(null);
    if (doc.state === "absent") return;
    void load(view.id, selected).then((a) => {
      if (alive) setArtifact(a);
    });
    return () => {
      alive = false;
    };
  }, [view.id, selected, doc.state, doc.sha, load]);

  const owned = ownsGate(view, role);
  const gate = view.gate;
  const techLead = gate?.mode === "via_pr";
  const selectedPr = view.artifactPrs[selected as 0 | 1 | 2 | 3 | 4 | 5] ?? null;
  const reviewPr = gate ? view.artifactPrs[({ 1: 0, 2: 1, 3: 2, 5: 4, 6: 5 } as const)[gate.s]] ?? null : null;

  return (
    <div className="detail">
      <button className="back" onClick={p.onBack}>← Pipeline</button>
      <div className="detail-title">
        <span className="id">{view.id}</span>
        <h1>{view.title}</h1>
        <span className="chip">{String(view.stage).padStart(2, "0")} · {STAGE_NAMES[view.stage - 1]}</span>
        <span className={`chip${view.risk === "high" ? " amber" : ""}`}>{riskLabel(view.risk)}</span>
        {view.cycle > 1 ? <span className="chip">cycle {view.cycle}</span> : null}
        {!view.valid ? <span className="chip red">validation error</span> : null}
      </div>

      <div className="stepper" role="tablist" aria-label="artifacts">
        {STAGE_INDEX.map((i) => {
          const d = view.docs[i as 0 | 1 | 2 | 3 | 4 | 5];
          const isCurrent = view.stage - 1 === i;
          const isPlanDraft = i === 2 && view.planState === "draft";
          const cls = dotClass(d.state, isCurrent, view.agent, isPlanDraft);
          return (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 ? <span className="arrow">→</span> : null}
              <button className={`step${selected === i ? " selected" : ""}`} role="tab" aria-selected={selected === i} onClick={() => p.onSelectArt(i)}>
                <span className={cls} />
                <span className="name">{ARTIFACT_NAMES[i]}</span>
                <span className="caption">{isPlanDraft ? `draft rev ${view.planRev}` : d.state === "absent" ? "future" : d.state === "pending-review" ? "in review" : d.state}</span>
              </button>
            </span>
          );
        })}
      </div>

      <div className="body">
        <section className="viewer" aria-label="artifact">
          <div className="viewer-head">
            <span className="file">{ARTIFACT_FILES[selected]}</span>
            <span className="chip gray">{viewerState(doc, view)}</span>
            {selectedPr && !selectedPr.merged ? <a className="chip" href={selectedPr.url} target="_blank" rel="noreferrer">PR #{selectedPr.number}</a> : null}
            {view.record ? <span className="chip">{view.record.system} {view.record.id}</span> : null}
          </div>
          {doc.state === "absent" ? (
            <pre className="viewer-body"><span className="viewer-empty">Not committed yet — this artifact is produced when the stage runs.</span></pre>
          ) : artifact === null ? (
            <pre className="viewer-body"><span className="viewer-empty">loading…</span></pre>
          ) : artifact.files ? (
            <pre className="viewer-body">{artifact.files.map((f) => `── ${f.path}\n${f.body}`).join("\n\n")}</pre>
          ) : (
            <pre className="viewer-body">{artifact.body ?? ""}</pre>
          )}
        </section>

        <aside className="rail">
          {gate ? (
            <div className="panel gate">
              <div className="eyebrow">Human gate · {waitingFor(gate.since, p.now)}</div>
              <h3>{gate.label}</h3>
              <div className="who">owner: {gate.ownerLabel}</div>
              {reviewPr ? <div className="who">in review as <a href={reviewPr.url} target="_blank" rel="noreferrer">PR #{reviewPr.number}</a> · merging it is the decision</div> : null}
              {techLead ? (
                <div className="waiting">Waiting on tech lead — approval happens via PR review on plan.md.{reviewPr ? <> <a href={reviewPr.url} target="_blank" rel="noreferrer">PR #{reviewPr.number}</a></> : null}</div>
              ) : owned ? (
                <>
                  <div className="actions">
                    <button className="btn primary" disabled={busy || !view.valid} onClick={() => { setBusy(true); p.onAccept(gate.s); }}>{gate.acceptLabel}</button>
                    <button className="btn" disabled={busy || feedback.trim() === ""} onClick={() => { setBusy(true); p.onSendBack(gate.s, feedback); }}>Send back</button>
                  </div>
                  <textarea className="feedback" placeholder="Feedback (required to send back)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                </>
              ) : (
                <div className="waiting">Waiting on the {gate.ownerLabel} — switch role in the top bar to act.</div>
              )}
              {techLead && role === "eng" ? (
                <>
                  <textarea className="feedback" placeholder="Feedback (required to send back)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                  <div className="actions"><button className="btn" disabled={busy || feedback.trim() === ""} onClick={() => { setBusy(true); p.onSendBack(gate.s, feedback); }}>Send back</button></div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="panel">
              <div className="eyebrow">{view.agent ? <span className="pulse">⌁ </span> : null}No gate open</div>
              <h3>{view.status}</h3>
              <div className="who">{view.waitingOnYou ? `waiting on you: ${view.waitingOnYou}` : "The next human gate opens when the artifact is committed."}</div>
            </div>
          )}
          {view.pr ? (
            <div className="panel pr">
              <div className="eyebrow">Pull request · {view.pr.provider}</div>
              <h3>{view.pr.url ? <a href={view.pr.url} target="_blank" rel="noreferrer">#{view.pr.number} {view.pr.branch}</a> : view.pr.branch}</h3>
              <div className="who">→ {view.pr.baseBranch} · head {view.pr.headSha.slice(0, 7)}{view.pr.mergeSha ? ` · merged ${view.pr.mergeSha.slice(0, 7)}` : ""}</div>
              <ul className="activity">
                {view.pr.checks.map((c) => <li key={c.name}><span className={`glyph ${c.verdict === "pass" ? "human" : "system"}`}>{c.verdict === "pass" ? "✓" : c.verdict === "fail" ? "✗" : "…"}</span><span>{c.name}</span><span className="when">{c.verdict}</span></li>)}
                <li><span className={`glyph ${view.pr.planMatches === false ? "system" : "human"}`}>{view.pr.planMatches === null ? "?" : view.pr.planMatches ? "✓" : "✗"}</span><span>plan matches</span><span className="when">{view.pr.planMatches === null ? "unknown" : view.pr.planMatches ? "yes" : "reviewer judgment"}</span></li>
                {view.pr.findings ? <li><span className="glyph system">·</span><span>findings</span><span className="when">{view.pr.findings.high} high · {view.pr.findings.medium} medium · {view.pr.findings.low} low</span></li> : null}
              </ul>
              {view.pr.reviewers.length > 0 ? <div className="who">reviewers: {view.pr.reviewers.join(", ")}</div> : null}
              <div className="who">
                {view.pr.review
                  ? `review of ${view.pr.review.headSha.slice(0, 7)} · session ${view.pr.review.session}${view.pr.review.headSha !== view.pr.headSha ? " · head moved since — review pending" : ""}`
                  : view.pr.mergedAt
                    ? "not reviewed by an agent"
                    : "review pending"}
              </div>
              {view.findings.length > 0 ? (
                <ul className="findings">
                  {view.findings.map((f) => (
                    <li key={f.id}>
                      <span className={`chip ${f.severity === "high" ? "red" : f.severity === "medium" ? "amber" : "gray"}`}>{f.severity}</span>
                      <span className="title">{f.title}</span>
                      {f.path ? <span className="when">{f.path}</span> : null}
                      {f.detail ? <pre className="detail">{f.detail}</pre> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {view.stage === 6 || view.pr?.mergedAt ? (
            <div className="panel">
              <div className="eyebrow">Eval suite</div>
              {view.harvested ? (
                <div className="who">harvested as <span className="mono">{view.harvested.id}</span> <span className={`chip ${view.harvested.status === "active" ? "green" : view.harvested.status === "draft" ? "amber" : "gray"}`}>{view.harvested.status}</span></div>
              ) : (
                <div className="actions"><button className="btn" disabled={busy} onClick={() => { setBusy(true); p.onHarvest(); }} title="draft a case from the intent and the acceptance line; the platform owner activates it">Add as eval</button></div>
              )}
            </div>
          ) : null}
          {!view.valid ? (
            <div className="panel">
              <div className="eyebrow">Validation errors</div>
              <ul className="errors">{view.validationErrors.map((d, i) => <li key={i}>{d.rule}: {d.message}</li>)}</ul>
            </div>
          ) : null}
          {view.planState !== "none" ? (
            <div className="panel">
              <div className="eyebrow">Auto mode</div>
              <div className="who">{view.autoEligible.value ? "eligible" : "not eligible"}</div>
              <ul className="activity">{view.autoEligible.terms.map((t) => <li key={t.name}><span className={`glyph ${t.ok ? "human" : "system"}`}>{t.ok ? "✓" : "✗"}</span><span>{t.name}</span><span className="when">{t.detail}</span></li>)}</ul>
            </div>
          ) : null}
          <div className="panel">
            <div className="eyebrow">Activity</div>
            <ul className="activity">
              {view.activity.slice(0, 20).map((a) => (
                <li key={a.id}>
                  <span className={`glyph ${a.actor}`}>{a.actor === "agent" ? "⌁" : a.actor === "human" ? "●" : "·"}</span>
                  <span>{a.actor === "human" ? `${a.role ? ROLE_LABEL[a.role as Role] ?? a.role : a.actorId} ` : ""}{a.text}</span>
                  <span className="when">{relativeTime(a.ts, p.now)}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

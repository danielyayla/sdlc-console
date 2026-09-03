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
              {techLead ? (
                <div className="waiting">Waiting on tech lead — approval happens via PR review on plan.md.</div>
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

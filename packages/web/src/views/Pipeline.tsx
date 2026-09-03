import type { ChangeView } from "@sdlc/core";
import { ARTIFACT_NAMES, STAGE_NAMES, gateOwnerLabel, riskLabel, waitingFor } from "../lib/format";

export interface PipelineProps {
  changes: ChangeView[];
  now: Date;
  onSelect: (id: string) => void;
}

export function Pipeline({ changes, now, onSelect }: PipelineProps) {
  return (
    <div className="pipeline">
      {STAGE_NAMES.map((name, i) => {
        const stage = i + 1;
        const cards = changes.filter((c) => c.stage === stage && !c.closed);
        return (
          <section className="column" key={stage} aria-label={`${stage} ${name}`}>
            <div className="column-head">
              <span className="column-num">{String(stage).padStart(2, "0")}</span>
              <span>{name}</span>
              <span className="column-count">{cards.length}</span>
            </div>
            <div className="column-caption">commits {ARTIFACT_NAMES[i]}</div>
            {cards.length === 0 ? <div className="empty">Nothing here</div> : null}
            {cards.map((c) => (
              <button className="card" key={c.id} onClick={() => onSelect(c.id)}>
                <div className="card-head">
                  <span className="id">{c.id}</span>
                  {c.agent ? <span className="chip agent pulse">⌁ agent</span> : null}
                  {c.risk === "high" ? <span className="chip amber">{riskLabel(c.risk)}</span> : null}
                  {!c.valid ? <span className="chip red">invalid</span> : null}
                </div>
                <div className="card-title">{c.title}</div>
                <div className="card-status">{c.status}</div>
                {c.gate ? (
                  <div className="gate-strip">
                    <span className="dot amber" />
                    <span>{c.gate.label}</span>
                    <span className="owner">{gateOwnerLabel(c)} · {waitingFor(c.gate.since, now)}</span>
                  </div>
                ) : null}
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

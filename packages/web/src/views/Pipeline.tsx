import type { ChangeView } from "@sdlc/core";
import { ARTIFACT_NAMES, STAGE_NAMES, gateOwnerLabel, riskLabel, waitingFor } from "../lib/format";

export interface PipelineProps {
  changes: ChangeView[];
  now: Date;
  onSelect: (id: string) => void;
}

const ENV_GLYPH: Record<string, string> = { succeeded: "✓", failed: "✗" };
const ENV_TONE: Record<string, string> = { succeeded: "green-text", failed: "red-text", running: "amber-text" };

/** Six planes, one card per change; a card's left edge is its state (amber gate waiting, orange agent working, red invalid) and every label is a word (rule 6). */
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
            {cards.map((c) => {
              const production = c.deploy.productionGate;
              const edge = !c.valid ? "red" : c.gate || production?.open ? "amber" : c.agent ? "agent pulse" : null;
              const showEnvs = (stage >= 5 || c.deploy.environments.some((e) => e.status !== "not-deployed")) && c.deploy.environments.length > 0;
              return (
                <button className={`card${edge ? ` edge-lit ${edge}` : ""}`} key={c.id} onClick={() => onSelect(c.id)}>
                  <div className="card-head mono">
                    <span className="muted">{c.id}</span>
                    {c.agent ? <span className="agent-text pulse">agent</span> : null}
                    {c.risk === "high" ? <span className="amber-text">{riskLabel(c.risk)}</span> : null}
                    {!c.valid ? <span className="red-text">invalid</span> : null}
                  </div>
                  <div className="card-title">{c.title}</div>
                  <div className="card-status">{c.status}</div>
                  {c.gate ? (
                    <div className="gate-line mono amber-text">{c.gate.label} · {gateOwnerLabel(c)} · {waitingFor(c.gate.since, now)}</div>
                  ) : production?.open ? (
                    <div className="gate-line mono amber-text">Deploy to {production.env} · {production.ownerRoles.join("/").toUpperCase()} · {production.blocked ? "rehearsal pending" : waitingFor(production.since ?? c.createdAt, now)}</div>
                  ) : null}
                  {showEnvs ? (
                    <div className="env-strip mono" aria-label="environments">
                      {c.deploy.environments.map((e) => (
                        <span key={e.name} className={ENV_TONE[e.status] ?? "faint"} title={`${e.name}: ${e.status}${e.latest ? ` ${e.latest.sha.slice(0, 7)}` : ""}`}>
                          {ENV_GLYPH[e.status] ?? "·"} {e.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

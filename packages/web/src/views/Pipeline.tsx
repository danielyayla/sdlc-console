import type { ChangeView } from "@sdlc/core";
import { OTHER_ROLES, ROLE_LABEL, STAGE_NAMES, hasOpenGate, owned, waitingFor, type Role } from "../lib/format";

/** The production gate's owner roles as lowercase words, the way core labels the artifact gates. */
const ROLE_WORD: Record<string, string> = { po: "product owner", eng: "engineer", tech_lead: "tech lead" };

/** The artifact each column commits; the Maintain caption names the loop-back. */
const STAGE_CAPTIONS = ["intent.md", "spec.md", "plan.md", "evals", "PR + findings", "incident → intent.md"] as const;

export interface PipelineProps {
  changes: ChangeView[];
  role: Role;
  now: Date;
  onSelect: (id: string) => void;
}

const ENV_GLYPH: Record<string, string> = { succeeded: "✓", failed: "✗" };
const ENV_TONE: Record<string, string> = { succeeded: "green-text", failed: "red-text", running: "amber-text" };

/** Six planes, one card per change; a card's left edge is its state (amber gate waiting, orange agent working, red invalid) and every label is a word (rule 6). */
export function Pipeline({ changes, role, now, onSelect }: PipelineProps) {
  const inFlight = changes.filter((c) => !c.closed);
  const n = inFlight.filter((c) => owned(c, role)).length;
  const a = inFlight.filter((c) => c.agent).length;
  const o = inFlight.filter((c) => hasOpenGate(c) && !owned(c, role)).length;
  return (
    <>
      <div className="pipeline-head">
        <div className="primary">{n === 0 ? `Nothing waits on the ${ROLE_LABEL[role]}.` : n === 1 ? `1 decision waits on the ${ROLE_LABEL[role]}.` : `${n} decisions wait on the ${ROLE_LABEL[role]}.`}</div>
        <div className="mono faint">{inFlight.length} changes in flight · {a} agents working · {o} waiting on {OTHER_ROLES[role]}</div>
      </div>
    <div className="pipeline">
      {STAGE_NAMES.map((name, i) => {
        const stage = i + 1;
        const cards = changes.filter((c) => c.stage === stage && !c.closed);
        return (
          <section className="pcol" key={stage} aria-label={`${stage} ${name}`}>
            <div className="pcol-head mono"><span>{String(stage).padStart(2, "0")} {name}</span><span className="faint">{cards.length}</span></div>
            <div className="pcol-caption mono faint">{STAGE_CAPTIONS[i]}</div>
            {cards.map((c) => {
              const production = c.deploy.productionGate;
              const mine = owned(c, role);
              // amber with glow when the decision is this role's; unlit when it is another role's; orange pulse while an agent works
              const edge = mine ? "amber" : hasOpenGate(c) ? "off" : c.agent ? "agent pulse" : "off";
              const showEnvs = (stage >= 5 || c.deploy.environments.some((e) => e.status !== "not-deployed")) && c.deploy.environments.length > 0;
              return (
                <button className={`pcard edge-lit ${edge}${mine ? " owned" : ""}`} key={c.id} onClick={() => onSelect(c.id)}>
                  <div className="pline mono faint">{c.id}{c.risk === "high" ? <span className="amber-text"> · high risk</span> : null}{!c.valid ? <span className="red-text"> · invalid</span> : null}</div>
                  <div className="ptitle">{c.title}</div>
                  <div className={`pline mono ${mine ? "amber-text" : "faint"}`}>
                    {c.gate
                      ? `${c.gate.label} · ${c.gate.ownerLabel} · ${waitingFor(c.gate.since, now)}`
                      : production?.open
                        ? `Deploy to ${production.env} · ${production.ownerRoles.map((r) => ROLE_WORD[r] ?? r).join(" or ")} · ${production.blocked ? "rehearsal pending" : waitingFor(production.since ?? c.createdAt, now)}`
                        : c.status}
                    {showEnvs ? (
                      <span aria-label="environments">
                        {c.deploy.environments.map((e) => (
                          <span key={e.name}> · <span className={ENV_TONE[e.status] ?? "faint"} title={`${e.name}: ${e.status}${e.latest ? ` ${e.latest.sha.slice(0, 7)}` : ""}`}>{ENV_GLYPH[e.status] ?? "·"} {e.name}</span></span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
    </>
  );
}

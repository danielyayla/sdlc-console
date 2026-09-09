import type { ChangeView } from "@sdlc/core";
import { ROLE_LABEL, STAGE_NAMES, hasOpenGate, waitingFor, type Role } from "../lib/format";

export interface GatesProps {
  changes: ChangeView[];
  queues: { yours: string[]; other: string[] };
  role: Role;
  now: Date;
  onSelect: (id: string) => void;
}

/** Two hairline lists: the decisions waiting on this role (lit amber) and the other role's (unlit). */
export function Gates({ changes, queues, role, now, onSelect }: GatesProps) {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const open = (ids: string[]) => ids.map((id) => byId.get(id)).filter((c): c is ChangeView => c !== undefined && hasOpenGate(c));
  const n = open(queues.yours).length;
  // the production gate (3.6) queues like the artifact gates: its row names the environment
  const rows = (ids: string[], yours: boolean) =>
    open(ids).map((c) => (
      <button className={`row edge-lit ${yours ? "amber" : "off"}`} key={c.id} onClick={() => onSelect(c.id)}>
        <span className="mono muted">{c.id}</span>
        <span className="label">{c.gate ? c.gate.label : `Deploy to ${c.deploy.productionGate?.env ?? "production"}`}</span>
        <span className="meta">{c.title} · {STAGE_NAMES[c.stage - 1]}{!c.gate && c.deploy.productionGate?.blocked ? " · rollback rehearsal pending" : ""}</span>
        <span className="since mono">{c.gate ? waitingFor(c.gate.since, now) : c.deploy.productionGate?.since ? waitingFor(c.deploy.productionGate.since, now) : ""}</span>
      </button>
    ));
  return (
    <div className="gates">
      <div className="primary">{n === 0 ? `Queue clear — nothing waits on the ${ROLE_LABEL[role]}.` : n === 1 ? `1 decision waits on the ${ROLE_LABEL[role]}.` : `${n} decisions wait on the ${ROLE_LABEL[role]}.`}</div>
      <section aria-label="yours">{rows(queues.yours, true)}</section>
      <section aria-label="other role">
        <h2 className="section-head"><span className="secondary">Other role</span><span>{queues.other.length}</span></h2>
        {rows(queues.other, false)}
      </section>
    </div>
  );
}

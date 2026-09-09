import type { ChangeView } from "@sdlc/core";
import { OTHER_ROLES, ROLE_LABEL, STAGE_NAMES, hasOpenGate, waitingFor, type Role } from "../lib/format";

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
  const others = open(queues.other);
  // the production gate (3.6) queues like the artifact gates: its row names the environment
  const label = (c: ChangeView) => (c.gate ? c.gate.label : `Deploy to ${c.deploy.productionGate?.env ?? "production"}`);
  const since = (c: ChangeView) => (c.gate ? waitingFor(c.gate.since, now) : c.deploy.productionGate?.since ? waitingFor(c.deploy.productionGate.since, now) : "");
  return (
    <div className="gates">
      <div className="primary">{n === 0 ? `Queue clear — nothing waits on the ${ROLE_LABEL[role]}.` : n === 1 ? `1 decision waits on the ${ROLE_LABEL[role]}.` : `${n} decisions wait on the ${ROLE_LABEL[role]}.`}</div>
      <section aria-label="yours">
        {open(queues.yours).map((c) => (
          <button className="grow edge-lit amber" key={c.id} onClick={() => onSelect(c.id)}>
            <span className="mono muted">{c.id}</span>
            <span className="gbody">
              <span className="glabel">{label(c)}</span>
              <span className="gmeta">{c.title} · {STAGE_NAMES[c.stage - 1]}{!c.gate && c.deploy.productionGate?.blocked ? " · rollback rehearsal pending" : ""}</span>
            </span>
            <span className="mono faint">{since(c)}</span>
          </button>
        ))}
      </section>
      <section aria-label="other role">
        <div className="eyebrow gother-head">Waiting on {OTHER_ROLES[role]} · {others.length}</div>
        {others.map((c) => (
          <button className="grow other edge-lit off" key={c.id} onClick={() => onSelect(c.id)}>
            <span className="mono">{c.id}</span>
            <span>{label(c)} · {c.title}</span>
            <span className="mono">{since(c)}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

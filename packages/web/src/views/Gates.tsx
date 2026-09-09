import type { ChangeView } from "@sdlc/core";
import { ROLE_LABEL, STAGE_NAMES, waitingFor, type Role } from "../lib/format";

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
  // the production gate (3.6) queues like the artifact gates: its row names the environment
  const rows = (ids: string[], yours: boolean) =>
    ids.map((id) => byId.get(id)).filter((c): c is ChangeView => c !== undefined && (c.gate !== null || c.deploy.productionGate?.open === true)).map((c) => (
      <button className={`row edge-lit ${yours ? "amber" : "off"}`} key={c.id} onClick={() => onSelect(c.id)}>
        <span className="mono muted">{c.id}</span>
        <span className="label">{c.gate ? c.gate.label : `Deploy to ${c.deploy.productionGate?.env ?? "production"}`}</span>
        <span className="meta">{c.title} · {STAGE_NAMES[c.stage - 1]}{!c.gate && c.deploy.productionGate?.blocked ? " · rollback rehearsal pending" : ""}</span>
        <span className="since mono">{c.gate ? waitingFor(c.gate.since, now) : c.deploy.productionGate?.since ? waitingFor(c.deploy.productionGate.since, now) : ""}</span>
      </button>
    ));
  return (
    <div className="gates">
      <section aria-label="yours">
        <h2 className="section-head"><span className="amber-text">Yours · {ROLE_LABEL[role]}</span><span>{queues.yours.length}</span></h2>
        {queues.yours.length === 0 ? <div className="empty">Queue clear — nothing waiting on the {ROLE_LABEL[role]}</div> : rows(queues.yours, true)}
      </section>
      <section aria-label="other role">
        <h2 className="section-head"><span className="secondary">Other role</span><span>{queues.other.length}</span></h2>
        {queues.other.length === 0 ? <div className="empty">Nothing here</div> : rows(queues.other, false)}
      </section>
    </div>
  );
}

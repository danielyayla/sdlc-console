import type { ChangeView } from "@sdlc/core";
import { ROLE_LABEL, STAGE_NAMES, waitingFor, type Role } from "../lib/format";

export interface GatesProps {
  changes: ChangeView[];
  queues: { yours: string[]; other: string[] };
  role: Role;
  now: Date;
  onSelect: (id: string) => void;
}

export function Gates({ changes, queues, role, now, onSelect }: GatesProps) {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const rows = (ids: string[], yours: boolean) =>
    ids.map((id) => byId.get(id)).filter((c): c is ChangeView => c !== undefined && c.gate !== null).map((c) => (
      <button className="row" key={c.id} onClick={() => onSelect(c.id)}>
        {yours ? <span className="dot amber" /> : <span className="dot inactive" />}
        <span className="id">{c.id}</span>
        <span className="label">{c.gate?.label}</span>
        <span className="meta">{c.title} · {STAGE_NAMES[c.stage - 1]}</span>
        <span className="since">{c.gate ? waitingFor(c.gate.since, now) : ""}</span>
        <span className="arrow">→</span>
      </button>
    ));
  return (
    <div className="gates">
      <section className="yours">
        <h2 className="yours">Yours · {ROLE_LABEL[role]}</h2>
        {queues.yours.length === 0 ? <div className="empty">Queue clear — nothing waiting on the {ROLE_LABEL[role]}.</div> : rows(queues.yours, true)}
      </section>
      <section className="other">
        <h2>Other role</h2>
        {queues.other.length === 0 ? <div className="empty">Nothing waiting elsewhere.</div> : rows(queues.other, false)}
      </section>
    </div>
  );
}

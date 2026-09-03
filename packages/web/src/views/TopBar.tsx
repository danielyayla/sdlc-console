import type { Snapshot } from "@sdlc/server";
import { ROLE_LABEL, type Role } from "../lib/format";
import type { UIState, View } from "../state";

const TABS: { view: Exclude<View, "detail">; label: string }[] = [
  { view: "board", label: "Pipeline" },
  { view: "gates", label: "Gates" },
  { view: "sessions", label: "Sessions" },
  { view: "config", label: "Config" },
  { view: "loop", label: "Loop" },
  { view: "security", label: "Security" },
  { view: "metrics", label: "Metrics" },
];

export interface TopBarProps {
  state: UIState;
  snapshot: Snapshot | null;
  repoLabel: string;
  onTab: (view: Exclude<View, "detail">) => void;
  onRole: (role: Role) => void;
}

export function TopBar({ state, snapshot, repoLabel, onTab, onRole }: TopBarProps) {
  const b = snapshot?.badges[state.role];
  const counts: Partial<Record<View, number>> = { gates: b?.gates ?? 0, loop: b?.loop ?? 0, security: b?.security ?? 0 };
  const held = snapshot?.identity.roles ?? [];
  const canSwitch = (r: Role) => held.length === 0 || held.includes(r);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-square" aria-hidden="true" />
        <span>Veri</span>
        <span className="brand-repo">/ {repoLabel} / SDLC console</span>
      </div>
      <nav className="tabs" aria-label="views">
        {TABS.map((t) => {
          const active = state.view === t.view || (state.view === "detail" && t.view === "board");
          const n = counts[t.view] ?? 0;
          return (
            <button key={t.view} className={`tab${active ? " active" : ""}`} onClick={() => onTab(t.view)} aria-current={active ? "page" : undefined}>
              {t.label}
              {n > 0 ? <span className="badge">{n}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="spacer" />
      <div className="switcher">
        <span className="eyebrow">Acting as</span>
        <div className="segment" role="group" aria-label="role">
          {(["po", "eng"] as Role[]).map((r) => (
            <button key={r} className={state.role === r ? "active" : ""} disabled={!canSwitch(r)} title={canSwitch(r) ? ROLE_LABEL[r] : `${snapshot?.identity.id ?? "you"} does not hold ${ROLE_LABEL[r]}`} onClick={() => onRole(r)}>
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

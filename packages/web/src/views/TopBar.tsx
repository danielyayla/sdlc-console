import type { Snapshot } from "@sdlc/server";
import type { ProductInfo } from "../api";
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

const ROLE_TAB: Record<Role, string> = { po: "Product owner", eng: "Engineer" };

export interface TopBarProps {
  state: UIState;
  snapshot: Snapshot | null;
  repoLabel: string;
  /** Products the server holds (3.2); the switcher shows when there is more than one. */
  products?: ProductInfo[];
  onTab: (view: Exclude<View, "detail">) => void;
  onRole: (role: Role) => void;
  onProduct?: (name: string | null) => void;
}

/** One hairline below; tabs are text with a lit underline on the active one; counts are mono numerals, not badges (rule 6). */
export function TopBar({ state, snapshot, repoLabel, products = [], onTab, onRole, onProduct }: TopBarProps) {
  const b = snapshot?.badges[state.role];
  const counts: Partial<Record<View, number>> = { gates: b?.gates ?? 0, loop: b?.loop ?? 0, security: b?.security ?? 0 };
  const held = snapshot?.identity.roles ?? [];
  const canSwitch = (r: Role) => held.length === 0 || held.includes(r);
  const primary = products.find((p) => p.primary)?.name ?? null;
  const selected = state.product ?? primary ?? "";
  return (
    <header className="topbar">
      <div className="brand mono">
        <span className="secondary">Veri</span>
        {products.length > 1 ? (
          <label className="product-switch">
            <select aria-label="product" value={selected} onChange={(e) => onProduct?.(e.target.value === primary ? null : e.target.value)}>
              {products.map((p) => (
                <option key={p.name} value={p.name} title={p.home}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span> / {repoLabel}</span>
        )}
      </div>
      <nav className="tabs" aria-label="views">
        {TABS.map((t) => {
          const active = state.view === t.view || (state.view === "detail" && t.view === "board");
          const n = counts[t.view] ?? 0;
          return (
            <button key={t.view} className={`tab${active ? " active" : ""}`} onClick={() => onTab(t.view)} aria-current={active ? "page" : undefined}>
              {t.label}
              {n > 0 ? <span className="count">{n}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="spacer" />
      {snapshot?.config.auth ? (
        <div className="whoami mono" title={`signed in via ${snapshot.config.auth.issuer}`}>
          <span className="secondary">{snapshot.identity.name ?? snapshot.identity.id}</span>
          <a className="signout" href="/auth/logout">Sign out</a>
        </div>
      ) : null}
      <div className="roles" role="group" aria-label="role">
        {(["po", "eng"] as Role[]).map((r) => (
          <button key={r} className={`tab${state.role === r ? " active" : ""}`} disabled={!canSwitch(r)} title={canSwitch(r) ? ROLE_LABEL[r] : `${snapshot?.identity.id ?? "you"} does not hold ${ROLE_LABEL[r]}`} onClick={() => onRole(r)}>
            {ROLE_TAB[r]}
          </button>
        ))}
      </div>
    </header>
  );
}

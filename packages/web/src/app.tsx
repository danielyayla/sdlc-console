import type { Snapshot } from "@sdlc/server";
import { useEffect, useReducer, useRef, useState } from "react";
import { act, subscribe, type Artifact } from "./api";
import type { Role } from "./lib/format";
import { initialState, reduce, type UIState } from "./state";
import { ChangeDetail, type ReproDraftView } from "./views/ChangeDetail";
import { Config } from "./views/Config";
import { Gates } from "./views/Gates";
import { Loop } from "./views/Loop";
import { Metrics } from "./views/Metrics";
import { Security } from "./views/Security";
import { Sessions } from "./views/Sessions";
import { Pipeline } from "./views/Pipeline";
import { Toast } from "./views/Toast";
import { TopBar } from "./views/TopBar";

export interface AppProps {
  /** Injected snapshot for server-side rendering; the browser subscribes instead. */
  snapshot?: Snapshot | null;
  initial?: UIState;
  now?: Date;
  loadArtifact?: (id: string, index: number) => Promise<Artifact>;
  live?: boolean;
  /** Injected prompt for tests; defaults to window.prompt. */
  promptImpl?: (text: string) => string | null;
}

/** The repro test a build session reported for the change and the engineer has not judged (from the session registry, never stored). */
function reproDraftOf(snapshot: Snapshot, changeId: string): ReproDraftView | null {
  for (const s of snapshot.sessions) {
    if (s.changeId !== changeId) continue;
    const draft = s["repro"] as Omit<ReproDraftView, "session"> | null | undefined;
    if (draft) return { session: s.id, ...draft };
  }
  return null;
}

export function App({ snapshot: injected = null, initial, now = new Date(), loadArtifact, live = true, promptImpl }: AppProps) {
  const [state, dispatch] = useReducer(reduce, initial ?? initialState());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(injected);
  const [connected, setConnected] = useState(injected !== null);
  const seeded = useRef(initial !== undefined);

  useEffect(() => {
    if (!live) return;
    return subscribe(setSnapshot, setConnected);
  }, [live]);

  useEffect(() => {
    if (snapshot && !seeded.current) {
      seeded.current = true;
      dispatch({ type: "seed-role", role: snapshot.defaultRole });
    }
  }, [snapshot]);

  useEffect(() => {
    if (!state.toast) return;
    const n = state.toast.n;
    const t = setTimeout(() => dispatch({ type: "toast.clear", n }), 2600);
    return () => clearTimeout(t);
  }, [state.toast]);

  const run = async (path: string, body: unknown) => {
    const r = await act(path, body);
    if ("ok" in r) {
      dispatch({ type: "art", index: null });
      dispatch({ type: "toast", text: r.toast });
    } else {
      const detail = r.diagnostics?.[0]?.message ?? r.error;
      dispatch({ type: "toast", text: r.retryable ? `${detail} · retry` : detail });
    }
  };

  const changes = snapshot?.changes ?? [];
  const selected = state.sel ? changes.find((c) => c.id === state.sel) ?? null : null;
  const repoLabel = snapshot?.config.present ? (snapshot.config as { products?: { name: string }[] }).products?.[0]?.name ?? "invoicing" : "repo";

  let body;
  if (!snapshot) body = <div className="connecting">connecting to sdlc serve…</div>;
  else if (state.view === "detail" && selected)
    body = (
      <ChangeDetail
        view={selected}
        role={state.role}
        art={state.art}
        now={now}
        {...(loadArtifact ? { loadArtifact } : {})}
        onBack={() => dispatch({ type: "back" })}
        onSelectArt={(i) => dispatch({ type: "art", index: i })}
        onAccept={(gate) => void run(`/changes/${selected.id}/accept`, { gate })}
        onSendBack={(gate, feedback) => void run(`/changes/${selected.id}/send-back`, { gate, feedback })}
        onLinkRecord={(system, id, url) => void run(`/changes/${selected.id}/records/link`, { system, id, ...(url ? { url } : {}) })}
        onRetryWriteback={(artifact) => void run(`/changes/${selected.id}/records/retry`, { artifact })}
        onHarvest={() => void run(`/changes/${selected.id}/harvest`, {})}
        reproDraft={reproDraftOf(snapshot, selected.id)}
        onReproConfirm={() => void run(`/changes/${selected.id}/repro/confirm`, {})}
        onReproReject={(reason) => void run(`/changes/${selected.id}/repro/reject`, { reason })}
        onLiftFreeze={(path, reason) => void run(`/changes/${selected.id}/freeze/lift`, { path, reason })}
        onDismissAutoFinding={(path, reason) => void run(`/changes/${selected.id}/auto-findings/dismiss`, { path, reason })}
        {...(promptImpl ? { prompt: promptImpl } : {})}
      />
    );
  else if (state.view === "gates") body = <Gates changes={changes} queues={snapshot.queues[state.role]} role={state.role} now={now} onSelect={(id) => dispatch({ type: "select", id })} />;
  else if (state.view === "sessions")
    body = (
      <Sessions
        snapshot={snapshot}
        onStart={(input) => void run("/sessions", input)}
        onAction={(id, action, body) => void run(`/sessions/${id}/${action}`, body ?? {})}
        onSelect={(id) => dispatch({ type: "select", id })}
        {...(promptImpl ? { prompt: promptImpl } : {})}
      />
    );
  else if (state.view === "config") body = <Config snapshot={snapshot} role={state.role} onAcceptProposal={(id) => void run(`/proposals/${id}/accept`, {})} onDismissProposal={(id, reason) => void run(`/proposals/${id}/dismiss`, { reason })} onRunSuite={() => void run("/evals/run", {})} {...(promptImpl ? { prompt: promptImpl } : {})} />;
  else if (state.view === "loop")
    body = (
      <Loop
        snapshot={snapshot}
        onAccept={(id) => void run(`/triage/${id}/accept`, {})}
        onDismiss={(id, reason, tune) => void run(`/triage/${id}/dismiss`, { reason, bandTune: tune })}
        {...(promptImpl ? { prompt: promptImpl } : {})}
      />
    );
  else if (state.view === "security")
    body = (
      <Security
        snapshot={snapshot}
        onPatch={(id) => void run(`/findings/${id}/patch`, {})}
        onEscalate={(id) => void run(`/findings/${id}/escalate`, {})}
        onDismiss={(id, reason) => void run(`/findings/${id}/dismiss`, { reason })}
        {...(promptImpl ? { prompt: promptImpl } : {})}
      />
    );
  else if (state.view === "metrics") body = <Metrics metrics={snapshot.metrics} sources={snapshot.metricSources} />;
  else body = <Pipeline changes={changes} now={now} onSelect={(id) => dispatch({ type: "select", id })} />;

  const blocking = snapshot?.validation.blocking ?? false;
  const warnings = snapshot ? snapshot.validation.diagnostics.filter((d) => !d.blocking).length : 0;

  return (
    <div className="app">
      <TopBar state={state} snapshot={snapshot} repoLabel={repoLabel} onTab={(view) => dispatch({ type: "tab", view })} onRole={(role: Role) => dispatch({ type: "role", role })} />
      <main className="main">
        {!connected && snapshot ? <div className="banner">reconnecting to sdlc serve…</div> : null}
        {blocking ? <div className="banner red">validation is blocking — run `sdlc validate` for the list</div> : warnings > 0 ? <div className="banner">{warnings} advisory diagnostic{warnings === 1 ? "" : "s"} — see Config</div> : null}
        {body}
      </main>
      {state.toast ? <Toast text={state.toast.text} /> : null}
    </div>
  );
}

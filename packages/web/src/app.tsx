import type { Snapshot } from "@sdlc/server";
import { useEffect, useReducer, useRef, useState } from "react";
import { act, exportHref, fetchJobs, fetchProducts, subscribe, type Artifact, type JobRow, type ProductInfo } from "./api";
import type { Role } from "./lib/format";
import { initialState, reduce, type FormState, type UIState } from "./state";
import { ChangeDetail, type ReproDraftView, type SessionLine } from "./views/ChangeDetail";
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
  /** Injected product list for server-side rendering; the browser fetches `/api/products`. */
  products?: ProductInfo[];
  /** Injected for server-side rendering (3.3): the job queue and the trace URL template the browser fetches. */
  jobs?: JobRow[];
  traceUrlTemplate?: string | null;
}

/** The repro test a build session reported for the change and the engineer has not judged (from the session registry, never stored). */
/** The change's sessions as the detail lists them (3.8): registry records reduced to the line and the harness gaps. */
function sessionLinesOf(snapshot: Snapshot, changeId: string): SessionLine[] {
  return snapshot.sessions
    .filter((s) => s.changeId === changeId)
    .map((s) => ({ id: s.id, kind: typeof s["kind"] === "string" ? s["kind"] : "build", mode: s.mode, status: s.status, startedAt: s.startedAt, harness: (s["harness"] as SessionLine["harness"] | undefined) ?? null, standIn: (s["standIn"] as SessionLine["standIn"] | undefined) ?? null, testEditAttempts: typeof s["testEditAttempts"] === "number" ? s["testEditAttempts"] : 0 }));
}

function reproDraftOf(snapshot: Snapshot, changeId: string): ReproDraftView | null {
  for (const s of snapshot.sessions) {
    if (s.changeId !== changeId) continue;
    const draft = s["repro"] as Omit<ReproDraftView, "session"> | null | undefined;
    if (draft) return { session: s.id, ...draft };
  }
  return null;
}

export function App({ snapshot: injected = null, initial, now = new Date(), loadArtifact, live = true, products: injectedProducts = [], jobs: injectedJobs = [], traceUrlTemplate: injectedTemplate = null }: AppProps) {
  const [state, dispatch] = useReducer(reduce, initial ?? initialState());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(injected);
  const [connected, setConnected] = useState(injected !== null);
  const [products, setProducts] = useState<ProductInfo[]>(injectedProducts);
  const [jobs, setJobs] = useState<JobRow[]>(injectedJobs);
  const [traceUrlTemplate, setTraceUrlTemplate] = useState<string | null>(injectedTemplate);
  const seeded = useRef(initial !== undefined);

  useEffect(() => {
    if (!live) return;
    // one socket per product in view: switching products resubscribes and the first message replaces the snapshot
    setSnapshot(null);
    return subscribe(setSnapshot, setConnected, state.product);
  }, [live, state.product]);

  useEffect(() => {
    if (!live) return;
    fetchProducts()
      .then((r) => {
        setProducts(r.products);
        setTraceUrlTemplate(r.traceUrlTemplate);
      })
      .catch(() => setProducts([]));
  }, [live]);

  // the job queue (jobs, runs) is cache state, not part of the snapshot: refetched when the snapshot moves, on the Sessions and Loop tabs
  const revision = snapshot?.revision ?? 0;
  useEffect(() => {
    if (!live || (state.view !== "sessions" && state.view !== "loop")) return;
    fetchJobs(state.product)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [live, state.view, state.product, revision]);

  useEffect(() => {
    if (snapshot && !seeded.current) {
      seeded.current = true;
      // hosted mode: start as a role the identity holds; local mode keeps defaultRole (the switcher is a view)
      const held = snapshot.identity.roles;
      const role = held.length === 0 || held.includes(snapshot.defaultRole) ? snapshot.defaultRole : held.includes("eng") ? "eng" : held.includes("po") ? "po" : snapshot.defaultRole;
      dispatch({ type: "seed-role", role });
    }
  }, [snapshot]);

  useEffect(() => {
    if (!state.toast) return;
    const n = state.toast.n;
    const t = setTimeout(() => dispatch({ type: "toast.clear", n }), 2600);
    return () => clearTimeout(t);
  }, [state.toast]);

  const onForm = (form: FormState) => dispatch(form ? { type: "form.open", ...form } : { type: "form.close" });
  const run = async (path: string, body: unknown) => {
    const r = await act(path, body, state.product);
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
  const current = products.find((p) => (state.product ? p.name === state.product : p.primary)) ?? null;
  const repoLabel = current?.name ?? state.product ?? (snapshot?.config.present ? "repo" : "repo");
  const artifactLoader = loadArtifact ?? ((id: string, index: number) => import("./api").then((m) => m.fetchArtifact(id, index, state.product)));

  // the other role the identity holds (local mode holds every role): the Decision section offers "Switch role"
  const otherRole: Role = state.role === "po" ? "eng" : "po";
  const held = snapshot?.identity.roles ?? [];
  const canSwitchRole = held.length === 0 || held.includes(otherRole);

  let body;
  if (!snapshot) body = <div className="connecting">connecting to sdlc serve…</div>;
  else if (state.view === "detail" && selected)
    body = (
      <ChangeDetail
        view={selected}
        role={state.role}
        codeHost={snapshot.config.codeHost}
        art={state.art}
        now={now}
        loadArtifact={artifactLoader}
        onBack={() => dispatch({ type: "back" })}
        onSelectArt={(i) => dispatch({ type: "art", index: i })}
        onAccept={(gate) => void run(`/changes/${selected.id}/accept`, { gate })}
        onSendBack={(gate, feedback) => void run(`/changes/${selected.id}/send-back`, { gate, feedback })}
        onLinkRecord={(system, id, url) => void run(`/changes/${selected.id}/records/link`, { system, id, ...(url ? { url } : {}) })}
        onRetryWriteback={(artifact) => void run(`/changes/${selected.id}/records/retry`, { artifact })}
        onHarvest={() => void run(`/changes/${selected.id}/harvest`, {})}
        reproDraft={reproDraftOf(snapshot, selected.id)}
        sessions={sessionLinesOf(snapshot, selected.id)}
        onReproConfirm={() => void run(`/changes/${selected.id}/repro/confirm`, {})}
        onReproReject={(reason) => void run(`/changes/${selected.id}/repro/reject`, { reason })}
        onLiftFreeze={(path, reason) => void run(`/changes/${selected.id}/freeze/lift`, { path, reason })}
        onDismissAutoFinding={(path, reason) => void run(`/changes/${selected.id}/auto-findings/dismiss`, { path, reason })}
        exportHref={exportHref(selected.id, state.product)}
        onDeploy={(env) => void run(`/changes/${selected.id}/deploy`, { env })}
        onRehearse={(env) => void run(`/changes/${selected.id}/rehearse-rollback`, { env })}
        form={state.form}
        onForm={onForm}
        {...(canSwitchRole ? { onSwitchRole: () => dispatch({ type: "role", role: otherRole }) } : {})}
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
        jobs={jobs}
        traceUrlTemplate={traceUrlTemplate}
        now={now}
        form={state.form}
        onForm={onForm}
      />
    );
  else if (state.view === "config") body = <Config snapshot={snapshot} role={state.role} onAcceptProposal={(id) => void run(`/proposals/${id}/accept`, {})} onDismissProposal={(id, reason) => void run(`/proposals/${id}/dismiss`, { reason })} onRunSuite={() => void run("/evals/run", {})} form={state.form} onForm={onForm} />;
  else if (state.view === "loop")
    body = (
      <Loop
        snapshot={snapshot}
        jobs={jobs}
        onAccept={(id) => void run(`/triage/${id}/accept`, {})}
        onDismiss={(id, reason, tune) => void run(`/triage/${id}/dismiss`, { reason, bandTune: tune })}
        onDetect={current?.engine ? () => void run("/detect", {}) : undefined}
        form={state.form}
        onForm={onForm}
      />
    );
  else if (state.view === "security")
    body = (
      <Security
        snapshot={snapshot}
        onPatch={(id) => void run(`/findings/${id}/patch`, {})}
        onEscalate={(id) => void run(`/findings/${id}/escalate`, {})}
        onDismiss={(id, reason) => void run(`/findings/${id}/dismiss`, { reason })}
        form={state.form}
        onForm={onForm}
      />
    );
  else if (state.view === "metrics") body = <Metrics metrics={snapshot.metrics} sources={snapshot.metricSources} />;
  else body = <Pipeline changes={changes} now={now} onSelect={(id) => dispatch({ type: "select", id })} />;

  const blocking = snapshot?.validation.blocking ?? false;
  const warnings = snapshot ? snapshot.validation.diagnostics.filter((d) => !d.blocking).length : 0;

  return (
    <div className="app">
      <TopBar state={state} snapshot={snapshot} repoLabel={repoLabel} products={products} onTab={(view) => dispatch({ type: "tab", view })} onRole={(role: Role) => dispatch({ type: "role", role })} onProduct={(name) => dispatch({ type: "product", name })} />
      <main className="main">
        {!connected && snapshot ? <div className="banner">reconnecting to sdlc serve…</div> : null}
        {blocking ? <div className="banner red">validation is blocking — run `sdlc validate` for the list</div> : warnings > 0 ? <div className="banner">{warnings} advisory diagnostic{warnings === 1 ? "" : "s"} — see Config</div> : null}
        {body}
      </main>
      {state.toast ? <Toast text={state.toast.text} /> : null}
    </div>
  );
}

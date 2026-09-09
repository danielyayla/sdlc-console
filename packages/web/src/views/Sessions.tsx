import type { ChangeView } from "@sdlc/core";
import type { Snapshot } from "@sdlc/server";
import { useState } from "react";
import type { JobRow } from "../api";
import { relativeTime, traceUrl } from "../lib/format";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";

interface RoundCard {
  n: number;
  results: { name: string; pass: boolean }[];
  screenshotRef?: string;
  diffPct?: number;
}

interface SessionCard {
  id: string;
  worktree: string;
  changeId: string;
  taskId: string | null;
  kind?: string;
  /** A band diagnose/propose session (3.4): no change, a breached metric and its triage item instead. */
  band?: { metric: string; tier: number; triageId: string; job: string } | null;
  mode: string;
  status: string;
  target: string | null;
  subagents?: { name: string; state: string }[];
  loop?: { state: string; rounds: RoundCard[] };
  verifier?: { ran: boolean; saw: boolean; mismatch: boolean } | null;
  testEditAttempts?: number;
  waitingOnYou?: { reason: string } | null;
  autoRationale?: { terms: string[] };
  command?: string;
  error?: string | null;
  traceId?: string | null;
  /** The harness the session runs through (3.8) and the guarantees it cannot honour, verbatim from the record. */
  harness?: { id: string; degraded: { guarantee: string; reason: string }[] } | null;
  /** The server-side stand-in for a hook the harness lacks (3.8): its verdict, verbatim. */
  standIn?: { guarantee: string; allowed: boolean; reason: string; rounds: number } | null;
}

/** One chip per unmet guarantee: the name, then the first clause of the reason; the full reason is the title. */
export function HarnessChips({ harness }: { harness: SessionCard["harness"] }) {
  if (!harness) return null;
  return (
    <>
      {harness.id !== "claude-code" ? <span className="chip gray" title={`harness ${harness.id}`}>harness {harness.id}</span> : null}
      {harness.degraded.map((d) => (
        <span className="chip amber" key={d.guarantee} title={`${d.guarantee}: ${d.reason}`}>{d.guarantee} — {d.reason.split(";")[0]}</span>
      ))}
    </>
  );
}

export interface SessionsProps {
  snapshot: Snapshot;
  onStart: (input: { changeId: string; kind?: string; target?: string; mode?: string }) => void;
  onAction: (id: string, action: "stop" | "takeover" | "raise-cap" | "message" | "downgrade", body?: Record<string, unknown>) => void;
  onSelect: (id: string) => void;
  /** The open inline reason form (rule 3): guidance and downgrade reasons are typed under the row. */
  form: FormState;
  onForm: (form: FormState) => void;
  /** The product's job queue (jobs, per-change runs, suite runs); the server's `/api/jobs`. */
  jobs?: JobRow[];
  /** `OTEL_TRACE_URL_TEMPLATE` from the server (3.3): with it, rows carrying a trace id link out. */
  traceUrlTemplate?: string | null;
  now?: Date;
}

const MODE_CLASS: Record<string, string> = { AUTO: "green", PLAN: "amber", HEADLESS: "gray", SUPERVISED: "" };

/** Diff chips: the session reports diffPct against the mock; the console colours it and shows the pictures. */
function diffClass(pct: number | undefined): string {
  if (pct === undefined) return "gray";
  return pct <= 2 ? "green" : pct <= 10 ? "amber" : "red";
}

function mockUrl(change: ChangeView | undefined): string | null {
  const mock = change?.visual.mock;
  if (!mock) return null;
  return `/api/changes/${change?.id}/design/${mock.path.split("/").pop() ?? ""}`;
}

const JOB_CLASS: Record<string, string> = { done: "green", failed: "red", running: "amber", skipped: "gray", queued: "gray" };

export function Sessions({ snapshot, onStart, onAction, onSelect, form, onForm, jobs = [], traceUrlTemplate = null, now = new Date() }: SessionsProps) {
  const close = () => onForm(null);
  const sessions = snapshot.sessions as unknown as SessionCard[];
  const cap = snapshot.capacity;
  const byId = new Map(snapshot.changes.map((c) => [c.id, c]));
  const candidates = snapshot.changes.filter((c) => c.valid && !c.closed && c.stage <= 4);
  const [changeId, setChangeId] = useState(candidates[0]?.id ?? "");
  const selected: ChangeView | undefined = byId.get(changeId);
  const [target, setTarget] = useState("");
  const [open, setOpen] = useState<{ session: string; n: number } | null>(null);
  const verificationMissing = !snapshot.claudeMd?.verification || snapshot.claudeMd.verification.commands.length === 0;
  const targetValue = target || selected?.acceptanceLine || "";
  const needsTarget = (selected?.stage ?? 0) === 4;
  const header = `${cap.active} active · review backlog ${cap.backlog}${cap.ceiling === null ? "" : cap.over ? ` · over the ceiling of ${cap.ceiling}` : ` · ceiling ${cap.ceiling}`}`;
  return (
    <div className="sessions">
      <div className="sessions-head">
        <span className="eyebrow">{header}</span>
        <form
          className="newsession"
          onSubmit={(e) => {
            e.preventDefault();
            if (!changeId) return;
            onStart({ changeId, ...(targetValue ? { target: targetValue } : {}) });
          }}
        >
          <select value={changeId} onChange={(e) => { setChangeId(e.target.value); setTarget(""); }} aria-label="change">
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.stageName} · {c.title}</option>)}
          </select>
          <input value={targetValue} onChange={(e) => setTarget(e.target.value)} placeholder="target — quantifiable: which tests, which endpoint, which mock" aria-label="target" />
          <button className="btn primary" type="submit" disabled={cap.over || !changeId || (needsTarget && targetValue.trim() === "")} title={cap.over ? `review backlog ${cap.backlog} over the ceiling ${cap.ceiling} — review finished sessions first` : needsTarget && targetValue.trim() === "" ? "waiting on you: define done" : "start a session"}>
            New session
          </button>
        </form>
      </div>
      {cap.over ? <div className="banner">review backlog {cap.backlog} is over the ceiling of {cap.ceiling} — review finished sessions before starting another (New session is disabled)</div> : null}
      {verificationMissing ? <div className="banner">no feedback loop — set up verification in CLAUDE.md ("Verifying your work"); sessions cannot run AUTO</div> : null}
      {selected?.visual.warning ? <div className="banner">{selected.id}: {selected.visual.warning}</div> : null}
      {sessions.length === 0 ? <div className="empty">No sessions yet.</div> : null}
      <div className="session-grid">
        {sessions.map((s) => {
          const running = s.status === "running";
          const live = running || s.status === "waiting";
          const change = byId.get(s.changeId);
          const lastRound = s.loop?.rounds.at(-1);
          const shots = (s.loop?.rounds ?? []).filter((r) => r.screenshotRef);
          const autonomous = s.mode === "AUTO" || s.mode === "HEADLESS";
          // FR-34: eligibility flips live; a running AUTO session is not interrupted, the card shows the new state
          const lostEligibility = s.mode === "AUTO" && live && change && !change.autoEligible.value ? change.autoEligible.terms.filter((t) => !t.ok).map((t) => t.name).join(", ") : null;
          const showing = open?.session === s.id ? shots.find((r) => r.n === open.n) : undefined;
          const mock = mockUrl(change);
          const trace = traceUrl(traceUrlTemplate, s.traceId);
          return (
            <article className="scard" key={s.id}>
              <div className="card-head">
                <span className={`dot ${running ? "orange pulse" : "inactive"}`} />
                <span className="mono">{s.worktree}</span>
                <span className={`chip ${MODE_CLASS[s.mode] ?? ""}`}>{s.mode === "PLAN" ? "PLAN MODE" : s.mode}</span>
                {s.changeId ? <button className="chip agent linkchip" onClick={() => onSelect(s.changeId)}>{s.changeId}</button> : s.band ? <span className="chip amber" title={s.band.job}>{s.band.metric} {s.band.tier}σ · {s.band.triageId}</span> : null}
                {s.taskId ? <span className="chip">{s.taskId}</span> : null}
                {trace ? <a className="chip" href={trace} target="_blank" rel="noreferrer" title={`OTel trace ${s.traceId ?? ""}`}>trace</a> : null}
              </div>
              <div className="card-status">{s.status}{s.loop ? ` · loop ${s.loop.state}` : ""}{lastRound ? ` · round ${lastRound.n}: ${lastRound.results.map((r) => `${r.name} ${r.pass ? "✓" : "✗"}`).join(" ")}` : ""}</div>
              {s.harness && (s.harness.id !== "claude-code" || s.harness.degraded.length > 0) ? <div className="card-status"><HarnessChips harness={s.harness} /></div> : null}
              {s.standIn ? <div className={`chip ${s.standIn.allowed ? "green" : "red"}`} title="checked by the console at exit, in place of the Stop hook the harness lacks">{s.standIn.guarantee} stand-in: {s.standIn.reason}</div> : null}
              {s.target ? <div className="card-status">target: {s.target}</div> : null}
              {s.waitingOnYou ? <div className="chip amber">waiting on you: {s.waitingOnYou.reason}</div> : null}
              {lostEligibility ? <div className="chip amber">no longer AUTO-eligible: {lostEligibility} — downgrade to SUPERVISED?</div> : null}
              {change?.visual.warning && shots.length === 0 && (s.kind ?? "build") === "build" ? <div className="chip amber">{change.visual.warning}</div> : null}
              {s.verifier ? <div className="card-status">verifier: ran {s.verifier.ran ? "✓" : "✗"} · saw {s.verifier.saw ? "✓" : "✗"} · mismatch {s.verifier.mismatch ? "✗" : "—"}</div> : null}
              {(s.testEditAttempts ?? 0) > 0 ? <div className="chip red">test edit attempts: {s.testEditAttempts}</div> : null}
              {shots.length > 0 ? (
                <div className="vstrip" aria-label="visual rounds">
                  <span className="eyebrow">visual</span>
                  {shots.map((r) => (
                    <button key={r.n} className={`chip ${diffClass(r.diffPct)}`} title={r.diffPct === undefined ? `round ${r.n}: screenshot, no diff reported` : `round ${r.n}: ${r.diffPct}% from the mock (reported by the session)`} onClick={() => setOpen(open?.session === s.id && open.n === r.n ? null : { session: s.id, n: r.n })}>
                      round {r.n} · {r.diffPct === undefined ? "no diff" : `${r.diffPct}%`}
                    </button>
                  ))}
                </div>
              ) : null}
              {showing ? (
                <div className="compare">
                  <div className="compare-head">
                    <span>round {showing.n} beside the mock</span>
                    <span className={`chip ${diffClass(showing.diffPct)}`}>{showing.diffPct === undefined ? "no diff reported" : `diff ${showing.diffPct}% · reported by the session`}</span>
                    <button className="btn" onClick={() => setOpen(null)}>Close</button>
                  </div>
                  <div className="compare-panes">
                    <figure>
                      <img src={`/api/sessions/${s.id}/rounds/${showing.n}/screenshot`} alt={`round ${showing.n} screenshot`} />
                      <figcaption>{showing.screenshotRef}</figcaption>
                    </figure>
                    <figure>
                      {mock ? <img src={mock} alt="design mock" /> : <div className="empty">no mock under design/ for {s.changeId}</div>}
                      <figcaption>{change?.visual.mock?.path ?? "—"}</figcaption>
                    </figure>
                  </div>
                </div>
              ) : null}
              {s.error ? <div className="errors">{s.error}</div> : null}
              {s.subagents && s.subagents.length > 0 ? <div className="card-status">{s.subagents.map((a) => <span className="chip" key={a.name}>{a.name} · {a.state}</span>)}</div> : null}
              {s.autoRationale && s.autoRationale.terms.length > 0 ? <div className="rationale">{s.autoRationale.terms.map((t) => <div key={t}>{t}</div>)}</div> : null}
              {s.status === "awaiting_engineer" && s.command ? <pre className="viewer-body cmd">{s.command}</pre> : null}
              <div className="actions">
                {running ? <button className="btn" onClick={() => onAction(s.id, "stop")}>Stop</button> : null}
                {running ? <button className="btn" onClick={() => onAction(s.id, "takeover")}>Take over</button> : null}
                {live && autonomous ? (
                  <button className="btn" title="AUTO → SUPERVISED: ends the headless harness, records the override, hands you the resume command" onClick={() => onForm({ kind: "downgrade", id: s.id })}>Downgrade to SUPERVISED</button>
                ) : null}
                {!running && s.status !== "awaiting_engineer" ? (
                  <button className="btn" onClick={() => onForm({ kind: "guidance", id: s.id })}>Add guidance</button>
                ) : null}
                {s.loop?.state === "stalled" ? <button className="btn" onClick={() => onAction(s.id, "raise-cap")}>Raise round cap once</button> : null}
              </div>
              {formOpen(form, "downgrade", s.id) ? <InlineReason placeholder="Reason for AUTO → SUPERVISED — optional; the override is recorded" submitLabel="Downgrade" required={false} onCancel={close} onSubmit={(v) => { close(); onAction(s.id, "downgrade", v["reason"] ? { reason: v["reason"] } : {}); }} /> : null}
              {formOpen(form, "guidance", s.id) ? <InlineReason placeholder={`Guidance for ${s.id} — goes to the session`} submitLabel="Send guidance" onCancel={close} onSubmit={(v) => { close(); onAction(s.id, "message", { text: v["reason"] ?? "" }); }} /> : null}
            </article>
          );
        })}
      </div>
      {jobs.length > 0 ? (
        <>
          <h2 className="eyebrow">Jobs · {jobs.length}</h2>
          <table className="bands" aria-label="jobs">
            <thead>
              <tr><th>Job</th><th>Change</th><th>State</th><th>Note</th><th>Updated</th><th>Trace</th></tr>
            </thead>
            <tbody>
              {jobs.slice(0, 40).map((j) => {
                const trace = traceUrl(traceUrlTemplate, j.traceId);
                return (
                  <tr key={j.key}>
                    <td className="mono" title={j.key}>{j.kind}</td>
                    <td>{j.changeId ? <button className="chip agent linkchip" onClick={() => onSelect(j.changeId)}>{j.changeId}</button> : <span className="muted">—</span>}{j.sessionId ? <span className="mono muted"> {j.sessionId}</span> : null}</td>
                    <td><span className={`chip ${JOB_CLASS[j.state] ?? ""}`}>{j.state}</span></td>
                    <td className="muted">{j.error ?? j.note ?? ""}</td>
                    <td className="muted">{relativeTime(j.updatedAt, now)}</td>
                    <td>{trace ? <a className="chip" href={trace} target="_blank" rel="noreferrer" title={`OTel trace ${j.traceId ?? ""}`}>trace</a> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
      <div className="footer">Sessions run Claude Code headless in a worktree per task; repo configuration (CLAUDE.md, .claude/**) steers them and is never edited here. Every session is logged per engineer. Autonomy is derived: AUTO can be taken away, never granted.</div>
    </div>
  );
}

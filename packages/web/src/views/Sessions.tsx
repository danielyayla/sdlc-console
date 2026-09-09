import type { ChangeView } from "@sdlc/core";
import type { Snapshot } from "@sdlc/server";
import { useState, type ReactNode } from "react";
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
  startedAt: string;
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

/** The harness and each unmet guarantee as words (rule 6): the name, then the first clause of the reason; the full reason is the title. */
export function HarnessWords({ harness }: { harness: SessionCard["harness"] }) {
  if (!harness) return null;
  return (
    <>
      {harness.id !== "claude-code" ? <span className="faint" title={`harness ${harness.id}`}>harness {harness.id}</span> : null}
      {harness.degraded.map((d) => (
        <span className="amber-text" key={d.guarantee} title={`${d.guarantee}: ${d.reason}`}>{d.guarantee} — {d.reason.split(";")[0]}</span>
      ))}
    </>
  );
}

export interface SessionsProps {
  snapshot: Snapshot;
  onStart: (input: { changeId: string; kind?: string; target?: string; mode?: string }) => void;
  onAction: (id: string, action: "stop" | "takeover" | "raise-cap" | "message" | "downgrade", body?: Record<string, unknown>) => void;
  onSelect: (id: string) => void;
  /** The selected row: its details and actions show; a row waiting on you shows them without being selected. */
  selected: string | null;
  onSelectSession: (id: string | null) => void;
  /** The open inline reason form (rule 3): guidance and downgrade reasons are typed under the row. */
  form: FormState;
  onForm: (form: FormState) => void;
  /** The product's job queue (jobs, per-change runs, suite runs); the server's `/api/jobs`. */
  jobs?: JobRow[];
  /** `OTEL_TRACE_URL_TEMPLATE` from the server (3.3): with it, rows carrying a trace id link out. */
  traceUrlTemplate?: string | null;
  now?: Date;
}

const MODE_WORD: Record<string, string> = { AUTO: "auto", PLAN: "plan mode", HEADLESS: "headless", SUPERVISED: "supervised" };

/** Diff words: the session reports diffPct against the mock; the console colours the word and shows the pictures. */
function diffClass(pct: number | undefined): string {
  if (pct === undefined) return "faint";
  return pct <= 2 ? "green-text" : pct <= 10 ? "amber-text" : "red-text";
}

function mockUrl(change: ChangeView | undefined): string | null {
  const mock = change?.visual.mock;
  if (!mock) return null;
  return `/api/changes/${change?.id}/design/${mock.path.split("/").pop() ?? ""}`;
}

const JOB_CLASS: Record<string, string> = { done: "green-text", failed: "red-text", running: "amber-text", skipped: "muted", queued: "muted" };

/** The session's status line: status, loop state, the last round's verdicts — or what it is waiting on you for. */
function headline(s: SessionCard): string {
  if (s.waitingOnYou) return `waiting on you: ${s.waitingOnYou.reason}`;
  const lastRound = s.loop?.rounds.at(-1);
  return `${s.status}${s.loop ? ` · loop ${s.loop.state}` : ""}${lastRound ? ` · round ${lastRound.n}: ${lastRound.results.map((r) => `${r.name} ${r.pass ? "✓" : "✗"}`).join(" ")}` : ""}`;
}

export function Sessions({ snapshot, onStart, onAction, onSelect, selected: selectedSession, onSelectSession, form, onForm, jobs = [], traceUrlTemplate = null, now = new Date() }: SessionsProps) {
  const close = () => onForm(null);
  const sessions = snapshot.sessions as unknown as SessionCard[];
  const cap = snapshot.capacity;
  const byId = new Map(snapshot.changes.map((c) => [c.id, c]));
  const candidates = snapshot.changes.filter((c) => c.valid && !c.closed && c.stage <= 4);
  const [changeId, setChangeId] = useState(candidates[0]?.id ?? "");
  const selected: ChangeView | undefined = byId.get(changeId);
  const [target, setTarget] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [open, setOpen] = useState<{ session: string; n: number } | null>(null);
  const verificationMissing = !snapshot.claudeMd?.verification || snapshot.claudeMd.verification.commands.length === 0;
  const targetValue = target || selected?.acceptanceLine || "";
  const needsTarget = (selected?.stage ?? 0) === 4;
  // rule 2: one primary row — the session waiting on you, else the running one, else the newest
  const primary = (sessions.find((s) => s.waitingOnYou) ?? sessions.find((s) => s.status === "running") ?? sessions[0])?.id ?? null;
  const header = `${cap.active} active · review backlog ${cap.backlog}${cap.ceiling === null ? "" : cap.over ? ` · over the ceiling of ${cap.ceiling}` : ` · ceiling ${cap.ceiling}`}`;
  return (
    <div className="sessions">
      <div className="sessions-head">
        <h1 className="primary">Sessions</h1>
        <span className="mono faint">{header}</span>
        <span className="spacer" />
        {composerOpen ? null : <button className="btn text accent-text" onClick={() => setComposerOpen(true)}>New session</button>}
      </div>
      {composerOpen ? (
        <form
          className="composer"
          aria-label="new session"
          onSubmit={(e) => {
            e.preventDefault();
            if (!changeId) return;
            setComposerOpen(false);
            onStart({ changeId, ...(targetValue ? { target: targetValue } : {}) });
          }}
        >
          <label>
            <span className="mono faint">change</span>
            <select value={changeId} onChange={(e) => { setChangeId(e.target.value); setTarget(""); }} aria-label="change">
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.stageName} · {c.title}</option>)}
            </select>
          </label>
          <label>
            <span className="mono faint">target — which tests, which endpoint, which mock</span>
            <input value={targetValue} onChange={(e) => setTarget(e.target.value)} aria-label="target" autoFocus />
          </label>
          <button className="btn primary" type="submit" disabled={cap.over || !changeId || (needsTarget && targetValue.trim() === "")} title={cap.over ? `review backlog ${cap.backlog} over the ceiling ${cap.ceiling} — review finished sessions first` : needsTarget && targetValue.trim() === "" ? "waiting on you: define done" : "start a session"}>
            Start
          </button>
          <button className="btn text" type="button" onClick={() => setComposerOpen(false)}>Cancel</button>
        </form>
      ) : null}
      {cap.over ? <div className="snote amber-text">review backlog {cap.backlog} is over the ceiling of {cap.ceiling} — review finished sessions before starting another (Start is disabled)</div> : null}
      {verificationMissing ? <div className="snote amber-text">no feedback loop — set up verification in CLAUDE.md ("Verifying your work"); sessions cannot run AUTO</div> : null}
      {composerOpen && selected?.visual.warning ? <div className="snote amber-text">{selected.id}: {selected.visual.warning}</div> : null}
      {sessions.length === 0 ? <div className="empty mono">Nothing here</div> : null}
      <div className="session-list">
        {sessions.map((s) => {
          const running = s.status === "running";
          const live = running || s.status === "waiting";
          const change = byId.get(s.changeId);
          const shots = (s.loop?.rounds ?? []).filter((r) => r.screenshotRef);
          const autonomous = s.mode === "AUTO" || s.mode === "HEADLESS";
          // FR-34: eligibility flips live; a running AUTO session is not interrupted, the row shows the new state
          const lostEligibility = s.mode === "AUTO" && live && change && !change.autoEligible.value ? change.autoEligible.terms.filter((t) => !t.ok).map((t) => t.name).join(", ") : null;
          const showing = open?.session === s.id ? shots.find((r) => r.n === open.n) : undefined;
          const mock = mockUrl(change);
          const trace = traceUrl(traceUrlTemplate, s.traceId);
          const edge = s.waitingOnYou ? "amber" : running ? "agent pulse" : "off";
          const isSelected = selectedSession === s.id;
          // usability exception: a row that is waiting on you shows its actions without being selected
          const expanded = isSelected || Boolean(s.waitingOnYou) || form?.id === s.id;
          const details: { k: string; v: ReactNode; cls?: string }[] = [];
          for (const r of s.loop?.rounds ?? []) details.push({ k: `round ${r.n}`, v: `${r.results.map((x) => `${x.name} ${x.pass ? "✓" : "✗"}`).join(" ")}${r.diffPct !== undefined ? ` · ${r.diffPct}% from mock` : ""}` });
          if (s.verifier) details.push({ k: "verifier", v: `ran ${s.verifier.ran ? "✓" : "✗"} · saw ${s.verifier.saw ? "✓" : "✗"} · mismatch ${s.verifier.mismatch ? "✗" : "—"}` });
          if (s.subagents && s.subagents.length > 0) details.push({ k: "subagents", v: s.subagents.map((a) => `${a.name} · ${a.state}`).join(" · ") });
          if (s.autoRationale && s.autoRationale.terms.length > 0) details.push({ k: `${MODE_WORD[s.mode] ?? s.mode.toLowerCase()} because`, v: s.autoRationale.terms.join(" · "), cls: "green-text" });
          if (shots.length > 0)
            details.push({
              k: "visual",
              v: (
                <span className="vwords" aria-label="visual rounds">
                  {shots.map((r) => (
                    <button key={r.n} className={`btn text ${diffClass(r.diffPct)}`} title={r.diffPct === undefined ? `round ${r.n}: screenshot, no diff reported` : `round ${r.n}: ${r.diffPct}% from the mock (reported by the session)`} onClick={() => setOpen(open?.session === s.id && open.n === r.n ? null : { session: s.id, n: r.n })}>
                      round {r.n} · {r.diffPct === undefined ? "no diff" : `${r.diffPct}%`}
                    </button>
                  ))}
                </span>
              ),
            });
          return (
            <article className={`srow edge-lit ${edge}${isSelected ? " selected" : ""}${primary === s.id ? " primary-row" : ""}`} key={s.id} aria-selected={isSelected}>
              <button className="srow-select" onClick={() => onSelectSession(isSelected ? null : s.id)} aria-expanded={expanded}>
              <div className="smeta">
                <span className="secondary">{s.worktree}</span>
                <span>{MODE_WORD[s.mode] ?? s.mode.toLowerCase()}</span>
                {s.changeId ? <span className="btn text mono" role="link" onClick={(e) => { e.stopPropagation(); onSelect(s.changeId); }}>{s.changeId}</span> : s.band ? <span className="amber-text" title={s.band.job}>{s.band.metric} {s.band.tier}σ · {s.band.triageId}</span> : null}
                {s.taskId ? <span>task {s.taskId}</span> : null}
                {(s.testEditAttempts ?? 0) > 0 ? <span className="red-text">test edits {s.testEditAttempts}</span> : null}
                <HarnessWords harness={s.harness ?? null} />
                {trace ? <a href={trace} target="_blank" rel="noreferrer" title={`OTel trace ${s.traceId ?? ""}`} onClick={(e) => e.stopPropagation()}>trace</a> : null}
                <span className="swhen">{relativeTime(s.startedAt, now)}</span>
              </div>
              <div className="shead">{headline(s)}</div>
              {s.target ? <div className="ssub">target · {s.target}</div> : null}
              {s.standIn ? <div className={`snote ${s.standIn.allowed ? "green-text" : "red-text"}`} title="checked by the console at exit, in place of the Stop hook the harness lacks">{s.standIn.guarantee} stand-in: {s.standIn.reason}</div> : null}
              {lostEligibility ? <div className="snote amber-text">no longer AUTO-eligible: {lostEligibility} — downgrade to supervised?</div> : null}
              {change?.visual.warning && shots.length === 0 && (s.kind ?? "build") === "build" ? <div className="snote amber-text">{change.visual.warning}</div> : null}
              {s.error ? <div className="snote red-text">{s.error}</div> : null}
              </button>
              {expanded ? (
              <>
              <div className="sdetail">
                {details.map((d) => (
                  <div className="kv" key={d.k}>
                    <span className="faint">{d.k}</span>
                    <span className={d.cls ?? "muted"}>{d.v}</span>
                  </div>
                ))}
                {showing ? (
                  <div className="compare">
                    <div className="compare-head">
                      <span>round {showing.n} beside the mock</span>
                      <span className={diffClass(showing.diffPct)}>{showing.diffPct === undefined ? "no diff reported" : `diff ${showing.diffPct}% · reported by the session`}</span>
                      <button className="btn text" onClick={() => setOpen(null)}>Close</button>
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
                {s.status === "awaiting_engineer" && s.command ? <pre className="viewer-body cmd">{s.command}</pre> : null}
              </div>
              <div className="sactions">
                {running ? <button className="btn text secondary" onClick={() => onAction(s.id, "stop")}>Stop</button> : null}
                {running ? <button className="btn text secondary" onClick={() => onAction(s.id, "takeover")}>Take over</button> : null}
                {live && autonomous ? (
                  <button className="btn text" title="AUTO → SUPERVISED: ends the headless harness, records the override, hands you the resume command" onClick={() => onForm({ kind: "downgrade", id: s.id })}>Downgrade to supervised</button>
                ) : null}
                {!running && s.status !== "awaiting_engineer" ? (
                  <button className="btn text" onClick={() => onForm({ kind: "guidance", id: s.id })}>Add guidance</button>
                ) : null}
                {s.loop?.state === "stalled" ? <button className="btn text" onClick={() => onAction(s.id, "raise-cap")}>Raise round cap once</button> : null}
              </div>
              {formOpen(form, "downgrade", s.id) ? <InlineReason placeholder="Reason for AUTO → SUPERVISED — optional; the override is recorded" submitLabel="Downgrade" required={false} onCancel={close} onSubmit={(v) => { close(); onAction(s.id, "downgrade", v["reason"] ? { reason: v["reason"] } : {}); }} /> : null}
              {formOpen(form, "guidance", s.id) ? <InlineReason placeholder={`Guidance for ${s.id} — goes to the session`} submitLabel="Send guidance" onCancel={close} onSubmit={(v) => { close(); onAction(s.id, "message", { text: v["reason"] ?? "" }); }} /> : null}
              </>
              ) : null}
            </article>
          );
        })}
      </div>
      {jobs.length > 0 ? (
        <details className="jobs">
          <summary className="mono">Jobs · {jobs.length}</summary>
          <div className="job-list" aria-label="jobs">
            {jobs.slice(0, 40).map((j) => {
              const trace = traceUrl(traceUrlTemplate, j.traceId);
              return (
                <div className="job" key={j.key}>
                  <span className="secondary" title={j.key}>{j.kind}</span>
                  <span className="muted">{j.changeId ? <button className="btn text mono" onClick={() => onSelect(j.changeId)}>{j.changeId}</button> : "—"}{j.sessionId ? ` ${j.sessionId}` : ""}</span>
                  <span className={JOB_CLASS[j.state] ?? "muted"}>{j.state}</span>
                  <span className="faint">{j.error ?? j.note ?? ""}</span>
                  <span className="faint">{relativeTime(j.updatedAt, now)}{trace ? <> · <a href={trace} target="_blank" rel="noreferrer" title={`OTel trace ${j.traceId ?? ""}`}>trace</a></> : null}</span>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

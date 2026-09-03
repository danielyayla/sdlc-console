import type { ChangeView } from "@sdlc/core";
import type { Snapshot } from "@sdlc/server";
import { useState } from "react";

interface SessionCard {
  id: string;
  worktree: string;
  changeId: string;
  taskId: string | null;
  mode: string;
  status: string;
  target: string | null;
  subagents?: { name: string; state: string }[];
  loop?: { state: string; rounds: { n: number; results: { name: string; pass: boolean }[] }[] };
  verifier?: { ran: boolean; saw: boolean; mismatch: boolean } | null;
  testEditAttempts?: number;
  waitingOnYou?: { reason: string } | null;
  autoRationale?: { terms: string[] };
  command?: string;
  error?: string | null;
}

export interface SessionsProps {
  snapshot: Snapshot;
  onStart: (input: { changeId: string; kind?: string; target?: string; mode?: string }) => void;
  onAction: (id: string, action: "stop" | "takeover" | "raise-cap" | "message", body?: Record<string, unknown>) => void;
  onSelect: (id: string) => void;
  prompt?: (text: string) => string | null;
}

const MODE_CLASS: Record<string, string> = { AUTO: "green", PLAN: "amber", HEADLESS: "gray", SUPERVISED: "" };

export function Sessions({ snapshot, onStart, onAction, onSelect, prompt = (t) => window.prompt(t) }: SessionsProps) {
  const sessions = snapshot.sessions as unknown as SessionCard[];
  const active = sessions.filter((s) => s.status === "running" || s.status === "waiting").length;
  const byId = new Map(snapshot.changes.map((c) => [c.id, c]));
  const backlog = sessions.filter((s) => s.status === "done" && (byId.get(s.changeId)?.stage ?? 6) < 6).length;
  const ceiling = snapshot.config.thresholds.sessionCeiling;
  const over = backlog > ceiling;
  const candidates = snapshot.changes.filter((c) => c.valid && !c.closed && c.stage <= 4);
  const [changeId, setChangeId] = useState(candidates[0]?.id ?? "");
  const selected: ChangeView | undefined = byId.get(changeId);
  const [target, setTarget] = useState("");
  const verificationMissing = !snapshot.claudeMd?.verification || snapshot.claudeMd.verification.commands.length === 0;
  const targetValue = target || selected?.acceptanceLine || "";
  const needsTarget = (selected?.stage ?? 0) === 4;
  return (
    <div className="sessions">
      <div className="sessions-head">
        <span className="eyebrow">{active} active · review backlog {backlog}{over ? ` · over the ceiling of ${ceiling}` : ""}</span>
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
          <button className="btn primary" type="submit" disabled={over || !changeId || (needsTarget && targetValue.trim() === "")} title={over ? `review backlog ${backlog} over the ceiling ${ceiling}` : needsTarget && targetValue.trim() === "" ? "waiting on you: define done" : "start a session"}>
            New session
          </button>
        </form>
      </div>
      {verificationMissing ? <div className="banner">no feedback loop — set up verification in CLAUDE.md ("Verifying your work"); sessions cannot run AUTO</div> : null}
      {sessions.length === 0 ? <div className="empty">No sessions yet.</div> : null}
      <div className="session-grid">
        {sessions.map((s) => {
          const running = s.status === "running";
          const lastRound = s.loop?.rounds.at(-1);
          return (
            <article className="scard" key={s.id}>
              <div className="card-head">
                <span className={`dot ${running ? "orange pulse" : "inactive"}`} />
                <span className="mono">{s.worktree}</span>
                <span className={`chip ${MODE_CLASS[s.mode] ?? ""}`}>{s.mode === "PLAN" ? "PLAN MODE" : s.mode}</span>
                <button className="chip agent linkchip" onClick={() => onSelect(s.changeId)}>{s.changeId}</button>
                {s.taskId ? <span className="chip">{s.taskId}</span> : null}
              </div>
              <div className="card-status">{s.status}{s.loop ? ` · loop ${s.loop.state}` : ""}{lastRound ? ` · round ${lastRound.n}: ${lastRound.results.map((r) => `${r.name} ${r.pass ? "✓" : "✗"}`).join(" ")}` : ""}</div>
              {s.target ? <div className="card-status">target: {s.target}</div> : null}
              {s.waitingOnYou ? <div className="chip amber">waiting on you: {s.waitingOnYou.reason}</div> : null}
              {s.verifier ? <div className="card-status">verifier: ran {s.verifier.ran ? "✓" : "✗"} · saw {s.verifier.saw ? "✓" : "✗"} · mismatch {s.verifier.mismatch ? "✗" : "—"}</div> : null}
              {(s.testEditAttempts ?? 0) > 0 ? <div className="chip red">test edit attempts: {s.testEditAttempts}</div> : null}
              {s.error ? <div className="errors">{s.error}</div> : null}
              {s.subagents && s.subagents.length > 0 ? <div className="card-status">{s.subagents.map((a) => <span className="chip" key={a.name}>{a.name} · {a.state}</span>)}</div> : null}
              {s.autoRationale && s.autoRationale.terms.length > 0 ? <div className="rationale">{s.autoRationale.terms.map((t) => <div key={t}>{t}</div>)}</div> : null}
              {s.status === "awaiting_engineer" && s.command ? <pre className="viewer-body cmd">{s.command}</pre> : null}
              <div className="actions">
                {running ? <button className="btn" onClick={() => onAction(s.id, "stop")}>Stop</button> : null}
                {running ? <button className="btn" onClick={() => onAction(s.id, "takeover")}>Take over</button> : null}
                {!running && s.status !== "awaiting_engineer" ? (
                  <button className="btn" onClick={() => { const text = prompt(`Guidance for ${s.id}:`); if (text && text.trim() !== "") onAction(s.id, "message", { text }); }}>Add guidance</button>
                ) : null}
                {s.loop?.state === "stalled" ? <button className="btn" onClick={() => onAction(s.id, "raise-cap")}>Raise round cap once</button> : null}
              </div>
            </article>
          );
        })}
      </div>
      <div className="footer">Sessions run Claude Code headless in a worktree per task; repo configuration (CLAUDE.md, .claude/**) steers them and is never edited here. Every session is logged per engineer.</div>
    </div>
  );
}

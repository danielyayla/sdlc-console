import type { Snapshot } from "@sdlc/server";
import { useState } from "react";
import { ONE_PAGE_WORDS } from "../lib/config-consts";

export interface ConfigProps {
  snapshot: Snapshot;
  onDismissProposal: (id: string, reason: string) => void;
  /** "Run suite": queues an eval suite run on the engine; the strip updates when the run commits. */
  onRunSuite: () => void;
  prompt?: (text: string) => string | null;
}

const ACTION_CLASS: Record<string, string> = { block: "red", ask: "amber", allow: "green" };

export function Config({ snapshot, onDismissProposal, onRunSuite, prompt = (t) => window.prompt(t) }: ConfigProps) {
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "draft" | "retired">("all");
  const cm = snapshot.claudeMd;
  const diags = snapshot.validation.diagnostics;
  const warningsFor = (prefix: string) => diags.filter((d) => d.path.startsWith(prefix) && d.severity === "warning");
  const cases = snapshot.evalCases;
  const runs = snapshot.evalRuns;
  const ev = snapshot.evals;
  const latest = ev.latest;
  const threshold = ev.threshold;
  const passPct = latest ? Math.round(latest.passRate * 100) : null;
  const suiteMin = ev.suiteMinSize;
  const underSized = ev.underSized;
  const budget = ev.budget;
  const passHistory = (caseId: string) => runs.slice(-30).map((r) => r.results.find((x) => x.caseId === caseId)?.pass ?? null);
  const filtered = statusFilter === "all" ? cases : cases.filter((c) => c.status === statusFilter);
  const records = snapshot.config.records;

  return (
    <div className="config">
      <div className={`banner${underSized || ev.mode === "scheduled" || (latest !== null && latest.verdict !== "pass") ? "" : " green"}`}>
        <span className={`chip ${underSized ? "amber" : "green"}`}>suite {ev.active}{underSized ? ` · under-sized (< ${suiteMin})` : ""}{ev.draft > 0 ? ` · ${ev.draft} draft` : ""}</span>{" "}
        <span className={`chip ${passPct === null ? "gray" : latest?.verdict === "pass" ? "green" : "amber"}`}>pass {passPct === null ? "n/a" : `${passPct}%`} · threshold {Math.round(threshold * 100)}%{latest?.verdict === "incomplete" ? " · incomplete (stopped at the budget) — never a pass" : ""}</span>{" "}
        <span className={`chip ${ev.mode === "scheduled" ? "amber" : "gray"}`}>{ev.mode}{ev.mode === "scheduled" ? ` · next run ${snapshot.config.evals.schedule ?? "per the CI schedule"} · config PRs not gated` : ev.gate.ok ? ` · config PRs pass on ${ev.gate.run?.id ?? "the current run"}` : ` · config PRs blocked: ${ev.gate.reason}`}</span>{" "}
        <span className={`chip ${budget.exhausted ? "amber" : "gray"}`}>budget {budget.limit === null ? "n/a" : `${budget.used} / ${budget.limit} used · ${budget.remaining} left (${budget.windowDays}d)`}</span>{" "}
        <button className="btn" onClick={onRunSuite} disabled={budget.exhausted} title={budget.exhausted ? "budget exhausted for this window" : "run every active case on the engine and commit the run file"}>Run suite</button>
      </div>

      <section className="panel">
        <div className="eyebrow">CLAUDE.md</div>
        {cm ? (
          <>
            <div className="card-status">
              version {cm.version ?? "—"} · {cm.wordCount} words · <span className={`chip ${cm.overOnePage ? "amber" : "green"}`}>{cm.overOnePage ? `over one page (${ONE_PAGE_WORDS})` : "under one page"}</span> · freshness: {latest ? `last suite run ${latest.startedAt}` : "no suite run yet"}
            </div>
            <div className="card-status">working rule: {cm.workingRule ?? <span className="chip amber">none written down</span>}</div>
            {cm.verification ? (
              <table className="bands">
                <thead><tr><th>Command</th><th>Runs</th><th>Healthy output</th><th>Single target</th></tr></thead>
                <tbody>
                  {cm.verification.commands.map((c) => (
                    <tr key={c.name + c.cmd}><td>{c.label}</td><td className="mono">{c.cmd}</td><td className="muted">{c.healthyOutput ?? "—"}</td><td>{c.singleTarget ? <span className="chip green">yes</span> : <span className="chip amber">wrap in one target</span>}</td></tr>
                  ))}
                  {cm.verification.testGlobs.length > 0 ? <tr><td>test files</td><td className="mono" colSpan={3}>{cm.verification.testGlobs.join(", ")}</td></tr> : null}
                  <tr><td>max rounds</td><td colSpan={3}>{cm.verification.maxLoopRounds}</td></tr>
                </tbody>
              </table>
            ) : (
              <div className="chip amber">no feedback loop — set up verification ("## Verifying your work")</div>
            )}
          </>
        ) : (
          <div className="chip amber">CLAUDE.md missing — all sessions run without a feedback loop</div>
        )}
        {warningsFor("CLAUDE.md").map((d, i) => <div className="warn" key={i}>⚠ {d.message}</div>)}
      </section>

      <section className="panel">
        <div className="eyebrow">Subagents</div>
        {snapshot.agents.length === 0 ? <div className="empty">none under .claude/agents</div> : null}
        {snapshot.agents.map((a) => <div className="card-status" key={a.name}><span className="mono">{a.name}</span> · {a.description} · <span className="muted">{a.tools.join(", ") || "all tools"}</span></div>)}
      </section>

      <section className="panel">
        <div className="eyebrow">Skills</div>
        <table className="bands">
          <thead><tr><th>Name</th><th>Trigger</th><th>Owner</th><th>Backed by</th><th>Must hold</th><th>Pass %</th></tr></thead>
          <tbody>
            {snapshot.skills.length === 0 ? <tr><td colSpan={6} className="empty">none under .claude/skills</td></tr> : null}
            {snapshot.skills.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td><td>{s.trigger}</td><td className="muted">{s.owner ?? "—"}</td>
                <td>{s.backedBy ? <span className="chip green">{s.backedBy}</span> : <span className="chip amber">advisory</span>}</td>
                <td>{s.mustHold ? (s.backedBy ? "yes" : <span className="chip amber">must hold · no hook</span>) : "no"}</td>
                <td className="muted">n/a · needs trigger tests</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="eyebrow">Hooks</div>
        <table className="bands">
          <thead><tr><th>Name</th><th>Action</th><th>Description</th><th>Phase</th><th>Scope</th></tr></thead>
          <tbody>
            {snapshot.hooks.length === 0 ? <tr><td colSpan={5} className="empty">no .claude/settings.json</td></tr> : null}
            {snapshot.hooks.map((h) => (
              <tr key={h.source + h.name + h.matcher}>
                <td className="mono">{h.name}</td>
                <td><span className={`chip ${ACTION_CLASS[h.action] ?? ""}`}>{h.action}</span></td>
                <td>{h.description || h.script}{h.warnings.map((w) => <div className="warn" key={w}>⚠ {w}</div>)}</td>
                <td>{h.phase}</td>
                <td><span className={`chip ${h.scope === "managed" ? "agent" : "gray"}`}>{h.scope}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="footer">Managed hooks are deployed by the platform team — engineers cannot switch them off.</div>
      </section>

      <section className="panel">
        <div className="eyebrow">Records · source of truth per artifact</div>
        <div className="card-status">{(["intent", "spec", "plan", "evals", "pr", "incident"] as const).map((k) => <span className="chip" key={k}>{k}: {records[k]}</span>)}</div>
      </section>

      <section className="panel">
        <div className="eyebrow">Proposals</div>
        {snapshot.proposals.length === 0 ? <div className="empty">none</div> : null}
        {snapshot.proposals.map((p) => (
          <div className={`tcard${p.status !== "open" ? " dismissed" : ""}`} key={p.id}>
            <div className="card-head"><span className="id">{p.id}</span><span className="chip">{p.type}</span><span className="chip gray">{p.status}</span>{p.pr ? <span className="chip amber">pending review</span> : null}</div>
            <div className="card-title">{p.text}</div>
            <div className="card-status">from {p.citations.join(", ")}</div>
            {p.status === "open" ? (
              <div className="actions">
                <button className="btn primary" disabled title="opens a PR on the code host (GitHub mode, Phase 2)">Accept</button>
                <button className="btn" onClick={() => { const reason = prompt(`Dismiss ${p.id} — reason (required):`); if (reason && reason.trim() !== "") onDismissProposal(p.id, reason); }}>Dismiss</button>
              </div>
            ) : null}
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="eyebrow">Evals · {cases.length} cases · {runs.length} runs</div>
        <div className="strip">{ev.strip.map((r) => <span key={r.id} className={`dot ${r.verdict === "pass" ? "green" : r.verdict === "fail" ? "amber" : "inactive"}`} title={`${r.id} · ${r.trigger} · ${r.verdict} ${Math.round(r.passRate * 100)}% · ${r.model} · ${r.changes.join(", ")}`} />)}{runs.length === 0 ? <span className="muted">no runs yet</span> : null}</div>
        <div className="filters">
          {(["all", "active", "draft", "retired"] as const).map((f) => <button key={f} className={`tab${statusFilter === f ? " active" : ""}`} onClick={() => setStatusFilter(f)}>{f}</button>)}
        </div>
        <table className="bands">
          <thead><tr><th>Id</th><th>Prompt</th><th>Source</th><th>Owner</th><th>Status</th><th>History</th></tr></thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{c.prompt}</td>
                <td><span className="chip gray">{c.source.type}{c.source.ref ? ` ${c.source.ref}` : ""}</span></td>
                <td className="muted">{c.owner}</td>
                <td>{c.status === "draft" && c.checks.length === 0 ? <span className="chip amber">draft · checks missing</span> : <span className={`chip ${c.status === "active" ? "green" : "gray"}`}>{c.status}</span>}</td>
                <td className="spark">{passHistory(c.id).map((p, i) => <span key={i} className={`dot ${p === null ? "inactive" : p ? "green" : "amber"}`} />)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

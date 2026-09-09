import type { Snapshot } from "@sdlc/server";
import { useState } from "react";
import { ONE_PAGE_WORDS } from "../lib/config-consts";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";

export interface ConfigProps {
  snapshot: Snapshot;
  /** Proposal accept/dismiss belong to eng (and platform); the PO sees the cards read-only. */
  role?: "po" | "eng";
  /** Accept opens the PR (or cuts the branch) for the code owners; the console never merges it. */
  onAcceptProposal: (id: string) => void;
  onDismissProposal: (id: string, reason: string) => void;
  /** "Run suite": queues an eval suite run on the engine; the strip updates when the run commits. */
  onRunSuite: () => void;
  /** The open inline reason form (rule 3): a dismissal reason is typed under its proposal. */
  form: FormState;
  onForm: (form: FormState) => void;
}

const ACTION_CLASS: Record<string, string> = { block: "red", ask: "amber", allow: "green" };

export function Config({ snapshot, role = "po", onAcceptProposal, onDismissProposal, onRunSuite, form, onForm }: ConfigProps) {
  const close = () => onForm(null);
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
  const skillThreshold = Math.round(snapshot.config.thresholds.skillPassThreshold * 100);
  const canDecide = role === "eng";
  // the harness table only earns its place when a guarantee is degraded; otherwise one sentence says so
  const harnessIds = snapshot.config.harnesses.length === 0 ? ["claude-code"] : snapshot.config.harnesses.map((h) => h.id);
  const harnessHealthy = snapshot.config.harnesses.every((h) => h.degraded.length === 0);
  const openProposals = snapshot.proposalViews.filter((p) => p.status === "open").length;
  // the status line: four figures, amber when the figure is a warning, green when it passes, neutral otherwise
  const figures: { label: string; value: string; note: string; tone: "amber-text" | "green-text" | "" }[] = [
    { label: "eval suite", value: `${ev.active} active`, note: `${underSized ? `under-sized · < ${suiteMin}` : `≥ ${suiteMin}`}${ev.draft > 0 ? ` · ${ev.draft} draft` : ""}`, tone: underSized ? "amber-text" : "" },
    { label: "pass rate", value: passPct === null ? "n/a" : `${passPct}%`, note: `threshold ${Math.round(threshold * 100)}%${latest ? ` · ${latest.id}` : ""}${latest?.verdict === "incomplete" ? " · incomplete (stopped at the budget) — never a pass" : ""}`, tone: passPct === null ? "" : latest?.verdict === "pass" ? "green-text" : "amber-text" },
    { label: "budget", value: budget.limit === null ? "n/a" : `${budget.used} / ${budget.limit}`, note: budget.limit === null ? "no budget set" : `${budget.remaining} left · ${budget.windowDays}d`, tone: budget.exhausted ? "amber-text" : "" },
    { label: "repeat mistakes", value: String(snapshot.repeatSignals.length), note: `${openProposals} open proposal${openProposals === 1 ? "" : "s"}`, tone: snapshot.repeatSignals.length > 0 ? "amber-text" : "" },
  ];
  const modeLine = `${ev.mode}${ev.mode === "scheduled" ? ` · next run ${snapshot.config.evals.schedule ?? "per the CI schedule"} · config PRs not gated` : ev.gate.ok ? ` · config PRs pass on ${ev.gate.run?.id ?? "the current run"}` : ` · config PRs blocked: ${ev.gate.reason}`}`;

  return (
    <div className="config">
      <div className="config-head">
        <h1 className="primary">Config</h1>
        <span className="mono faint">read from CLAUDE.md and .claude/** · never edited here</span>
      </div>

      <div className="figures" aria-label="status">
        {figures.map((f) => (
          <div className="figure" key={f.label}>
            <div className="mono faint">{f.label}</div>
            <div className={`value tabular ${f.tone}`}>{f.value}</div>
            <div className="mono muted">{f.note}</div>
          </div>
        ))}
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
        <div className="eyebrow">Skills &amp; subagents · advisory unless a hook backs them · pass % from trigger tests (threshold {skillThreshold}%)</div>
        <table className="bands">
          <thead><tr><th>Name</th><th>Trigger</th><th>Owner</th><th>Version</th><th>Backed by</th><th>Must hold</th><th>Pass %</th><th>Findings citing</th></tr></thead>
          <tbody>
            {snapshot.skillStatus.length === 0 ? <tr><td colSpan={8} className="empty">none under .claude/skills</td></tr> : null}
            {snapshot.skillStatus.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td><td>{s.trigger}</td><td className="muted">{s.owner ?? "—"}</td>
                <td className="mono">{s.version ?? "—"}</td>
                <td>{s.backing === "hook" ? <span className={`chip ${s.backingScope === "managed" ? "agent" : "green"}`}>{s.backedBy}{s.backingScope === "managed" ? " · managed" : ""}</span> : s.backing === "unknown-hook" ? <span className="chip red" title="named in SKILL.md but not in .claude/settings.json">{s.backedBy} · not installed</span> : <span className="chip amber">advisory</span>}</td>
                <td>{s.mustHold ? (s.mustHoldWithoutHook ? <span className="chip amber">must hold · no hook</span> : "yes") : "no"}</td>
                <td title={s.passNote}>{s.passPct === null ? <span className="muted">{s.passNote}</span> : <span className={`chip ${s.belowThreshold ? "amber" : "green"}`}>{s.passPct}%{s.belowThreshold ? " · not triggering" : ""}</span>}<div className="muted">{s.triggerTests.active} trigger test{s.triggerTests.active === 1 ? "" : "s"}{s.run ? ` · ${s.run}` : ""}</div></td>
                <td>{s.findingsCiting}</td>
              </tr>
            ))}
            {snapshot.agents.map((a) => (
              <tr key={`agent:${a.name}`}>
                <td className="mono">{a.name}</td><td colSpan={5}>{a.description} · <span className="muted">{a.tools.join(", ") || "all tools"}</span></td><td colSpan={2} className="muted">{a.model ?? "subagent"}</td>
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
        {harnessHealthy ? <div className="footer mono">harness {harnessIds.join(", ")} · every managed guarantee honoured</div> : null}
      </section>

      {harnessHealthy ? null : (
      <section className="panel">
        <div className="eyebrow">Harness · what runs the sessions and which guarantees it cannot honour</div>
        <table className="bands">
          <thead><tr><th>Harness</th><th>Session kinds</th><th>Process</th><th>Not honoured — stand-in</th></tr></thead>
          <tbody>
            {snapshot.config.harnesses.length === 0 ? <tr><td className="mono">claude-code</td><td>all</td><td className="mono">claude -p … --mcp-config … --allowedTools …</td><td><span className="chip green">every managed guarantee honoured</span></td></tr> : null}
            {snapshot.config.harnesses.map((h) => (
              <tr key={h.id}>
                <td className="mono">{h.id}</td>
                <td>{h.jobs.length === 0 ? "all" : h.jobs.join(", ")}</td>
                <td className="mono">{h.kind === "claude-code" ? `${h.bin ?? "claude"} -p … --mcp-config … --allowedTools …` : [h.command ?? "", ...h.args].join(" ")}</td>
                <td>{h.degraded.length === 0 ? <span className="chip green">every managed guarantee honoured</span> : h.degraded.map((d) => <div className="warn" key={d.guarantee} title={d.reason}>⚠ {d.guarantee} — {d.reason}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="footer">Hooks not run by the harness are checked by the console where a real check exists (done at exit, plan-sync and test-freeze on the per-change run); production-gate has no in-process stand-in.</div>
      </section>
      )}

      <section className="panel">
        <div className="eyebrow">Records · source of truth per artifact</div>
        <div className="card-status">{(["intent", "spec", "plan", "evals", "pr", "incident"] as const).map((k) => <span className={`chip${records[k] === "repo" ? "" : " amber"}`} key={k}>{k}: {records[k]}</span>)}<span className="chip gray">connector: {snapshot.config.recordsConnector ?? "none"}</span></div>
      </section>

      <section className="panel">
        <div className="eyebrow">Repeat mistakes · the same reason twice across sessions → a CLAUDE.md line</div>
        {snapshot.repeatSignals.length === 0 ? <div className="empty">none — no reason was cited twice</div> : null}
        {snapshot.repeatSignals.map((sig) => (
          <div className="card-status" key={sig.reason}>
            <span className={`chip ${sig.proposal ? "gray" : "amber"}`}>{sig.count}×</span> "{sig.display}" · from {sig.citations.join(", ")} · {sig.proposal ? <span>{sig.proposal.id} {sig.proposal.status}</span> : <span className="chip amber">no proposal yet — the engine drafts one (sdlc serve --engine)</span>}
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="eyebrow">Proposals · Accept opens a PR for the code owners; the console never edits CLAUDE.md</div>
        {snapshot.proposalViews.length === 0 ? <div className="empty">none</div> : null}
        {snapshot.proposalViews.map((p) => (
          <div className={`tcard${p.status === "dismissed" ? " dismissed" : ""}`} key={p.id}>
            <div className="card-head">
              <span className="id">{p.id}</span><span className="chip">{p.type}</span><span className={`chip ${p.status === "open" ? "amber" : "gray"}`}>{p.status}</span>
              {p.status === "accepted" ? (p.landed ? <span className="chip green">merged · CLAUDE.md carries it</span> : p.pr?.url ? <a className="chip amber" href={p.pr.url} target="_blank" rel="noreferrer">pending review · PR #{p.pr.number}</a> : <span className="chip amber">pending review · {p.pr?.branch ?? "branch"}</span>) : null}
              {p.seen > 0 ? <span className="chip gray" title={p.reason ?? ""}>seen {p.seen}×</span> : null}
            </div>
            <div className="card-title">{p.text}</div>
            <div className="card-status">from {p.citations.join(", ")}{p.reason ? ` · reason "${p.reason}"` : ""}{p.dismissal ? ` · dismissed by ${p.dismissal.by}: ${p.dismissal.reason}` : ""}</div>
            {p.status === "open" ? (
              <div className="actions">
                <button className="btn primary" disabled={!canDecide} title={canDecide ? "commit the line on a branch and open the PR for the code owners" : "eng or platform accepts a proposal"} onClick={() => onAcceptProposal(p.id)}>Accept · open PR</button>
                <button className="btn" disabled={!canDecide} onClick={() => onForm({ kind: "dismiss-proposal", id: p.id })}>Dismiss</button>
              </div>
            ) : null}
            {p.status === "open" && formOpen(form, "dismiss-proposal", p.id) ? <InlineReason placeholder="Why this line should not be added — required" submitLabel="Dismiss proposal" onCancel={close} onSubmit={(v) => { close(); onDismissProposal(p.id, v["reason"] ?? ""); }} /> : null}
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="eyebrow section-head"><span className="secondary">Evals</span><span>{cases.length} cases · {runs.length} runs · {modeLine}</span><span className="spacer" /><button className="btn text" onClick={onRunSuite} disabled={budget.exhausted} title={budget.exhausted ? "budget exhausted for this window" : "run every active case on the engine and commit the run file"}>Run suite</button></div>
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

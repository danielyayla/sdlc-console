import type { Snapshot } from "@sdlc/server";
import { useState } from "react";
import { ONE_PAGE_WORDS } from "../lib/config-consts";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";

export interface ConfigProps {
  snapshot: Snapshot;
  /** Proposal accept/dismiss belong to eng (and platform); the PO sees the proposals read-only. */
  role?: "po" | "eng";
  /** Accept opens the PR (or cuts the branch) for the code owners; the console never merges it. */
  onAcceptProposal: (id: string) => void;
  onDismissProposal: (id: string, reason: string) => void;
  /** "Run suite": queues an eval suite run on the engine; the strip updates when the run commits. */
  onRunSuite: () => void;
  /** The open inline reason form (rule 3): a dismissal reason is typed under its proposal. */
  form: FormState;
  onForm: (form: FormState) => void;
  /** "Switch role" for the product owner when the identity also holds the engineer role. */
  onSwitchRole?: () => void;
}

const ACTION_TONE: Record<string, string> = { block: "red-text", ask: "amber-text", allow: "green-text" };
const VERDICT_TONE: Record<string, string> = { pass: "green", fail: "amber", incomplete: "red" };

export function Config({ snapshot, role = "po", onAcceptProposal, onDismissProposal, onRunSuite, form, onForm, onSwitchRole }: ConfigProps) {
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
  const filtered = statusFilter === "all" ? cases : cases.filter((c) => c.status === statusFilter);
  const records = snapshot.config.records;
  const skillThreshold = Math.round(snapshot.config.thresholds.skillPassThreshold * 100);
  const canDecide = role === "eng";
  // the harness table only earns its place when a guarantee is degraded; otherwise one sentence says so
  const harnessIds = snapshot.config.harnesses.length === 0 ? ["claude-code"] : snapshot.config.harnesses.map((h) => h.id);
  const harnessHealthy = snapshot.config.harnesses.every((h) => h.degraded.length === 0);
  // a repeat signal nothing answers yet renders in the proposal's shape (removals log: the Repeat-mistakes section is gone)
  const unanswered = snapshot.repeatSignals.filter((sig) => sig.proposal === null);
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

      {/* Proposals — the primary object (rule 2): the same reason twice → a CLAUDE.md line; Accept opens a PR for the code owners, the console never edits CLAUDE.md */}
      <section className="proposals" aria-label="proposals">
        <div className="eyebrow">Proposals · the same reason twice → a CLAUDE.md line · accepting opens a PR for the code owners</div>
        <div className="proposal-list">
          {snapshot.proposalViews.length === 0 && unanswered.length === 0 ? <div className="empty mono">Nothing here</div> : null}
          {unanswered.map((sig) => (
            <article className="proposal edge-lit amber" key={`signal:${sig.reason}`}>
              <div className="meta"><span className="muted">no proposal yet</span><span>from {sig.citations.join(", ")}</span><span title={sig.reason}>seen {sig.count}×</span></div>
              <div className="text">{sig.display}</div>
              <div className="line">The engine drafts a proposal (sdlc serve --engine).</div>
            </article>
          ))}
          {snapshot.proposalViews.map((p) => {
            const status = p.status === "open" ? <span className="amber-text">open</span> : p.status === "accepted" ? (p.landed ? <span className="green-text">merged · CLAUDE.md carries it</span> : p.pr?.url ? <a className="amber-text" href={p.pr.url} target="_blank" rel="noreferrer">pending review · PR #{p.pr.number}</a> : <span className="amber-text">pending review · {p.pr?.branch ?? "branch"}</span>) : <span>dismissed{p.dismissal ? ` by ${p.dismissal.by}: ${p.dismissal.reason}` : ""}</span>;
            return (
              <article className={`proposal edge-lit ${p.status === "open" ? "amber" : "off"}${p.status === "dismissed" ? " dismissed" : ""}`} key={p.id}>
                <div className="meta"><span className="muted">{p.id}</span><span>{p.type}</span><span>from {p.citations.join(", ")}</span>{p.seen > 0 ? <span title={p.reason ?? ""}>seen {p.seen}×</span> : null}{status}</div>
                <div className="text">{p.text}</div>
                {p.reason ? <div className="line">reason "{p.reason}"</div> : null}
                {p.status === "open" ? (
                  canDecide ? (
                    <>
                      <div className="actions">
                        <button className="btn primary" title="commit the line on a branch and open the PR for the code owners" onClick={() => onAcceptProposal(p.id)}>Accept · open PR</button>
                        {formOpen(form, "dismiss-proposal", p.id) ? null : <button className="btn text" onClick={() => onForm({ kind: "dismiss-proposal", id: p.id })}>Dismiss</button>}
                      </div>
                      {formOpen(form, "dismiss-proposal", p.id) ? <InlineReason placeholder="Why this line should not be added — required" submitLabel="Dismiss proposal" onCancel={close} onSubmit={(v) => { close(); onDismissProposal(p.id, v["reason"] ?? ""); }} /> : null}
                    </>
                  ) : (
                    <div className="line">The engineer or platform decides.{onSwitchRole ? <> <button className="btn text accent-text" onClick={onSwitchRole}>Switch role</button></> : null}</div>
                  )
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <div className="config-cols">
        <div className="col">
          <section aria-label="evals">
            <div className="section-head">
              <span className="secondary">Evals</span>
              <span>{cases.length} cases · {runs.length} runs · {modeLine}</span>
              <span className="spacer" />
              <button className="btn text" onClick={onRunSuite} disabled={budget.exhausted} title={budget.exhausted ? "budget exhausted for this window" : "run every active case on the engine and commit the run file"}>Run suite</button>
            </div>
            <div className="strip-bars" aria-label="run history">
              {ev.strip.map((r) => <span key={r.id} className={`bar-lit ${VERDICT_TONE[r.verdict] ?? "off"}`} title={`${r.id} · ${r.trigger} · ${r.verdict} ${Math.round(r.passRate * 100)}% · ${r.model} · ${r.changes.join(", ")}`} />)}
              {runs.length === 0 ? <span className="mono faint">no runs yet</span> : null}
            </div>
            <div className="filters" role="group" aria-label="status filter">
              {(["all", "active", "draft", "retired"] as const).map((f) => <button key={f} className={`btn text mono filter${statusFilter === f ? " active" : ""}`} aria-pressed={statusFilter === f} onClick={() => setStatusFilter(f)}>{f}</button>)}
            </div>
            {filtered.length === 0 ? <div className="empty mono">Nothing here</div> : null}
            {filtered.map((c) => (
              <div className="crow evals" key={c.id}>
                <span className="mono muted">{c.id}</span>
                <span className="cbody">
                  <span className="secondary">{c.prompt}</span>
                  <span className="mono faint">{c.source.type}{c.source.ref ? ` ${c.source.ref}` : ""} · {c.owner}</span>
                </span>
                <span className={`mono ${c.status === "draft" ? "amber-text" : c.status === "active" ? "green-text" : "faint"}`}>{c.status === "draft" && c.checks.length === 0 ? "draft · checks missing" : c.status}</span>
              </div>
            ))}
          </section>

          <section aria-label="records">
            <div className="section-head"><span className="secondary">Records</span><span>source of truth per artifact · connector {snapshot.config.recordsConnector ?? "none"}</span></div>
            <div className="words">
              {(["intent", "spec", "plan", "evals", "pr", "incident"] as const).map((k) => <span className={records[k] === "repo" ? "muted" : "amber-text"} key={k}>{k} · {records[k]}</span>)}
            </div>
          </section>
        </div>

        <div className="col">
          <section aria-label="CLAUDE.md">
            <div className="section-head"><span className="secondary">CLAUDE.md</span>{cm ? <span>v{cm.version ?? "—"} · {cm.wordCount} words · <span className={cm.overOnePage ? "amber-text" : ""}>{cm.overOnePage ? `over one page (${ONE_PAGE_WORDS})` : "under one page"}</span></span> : <span className="amber-text">missing — all sessions run without a feedback loop</span>}</div>
            {cm ? (
              <>
                <div className="crow line">working rule · {cm.workingRule ?? <span className="amber-text">none written down</span>}</div>
                {cm.verification ? (
                  <>
                    {cm.verification.commands.map((c) => (
                      <div className="crow verify" key={c.name + c.cmd}>
                        <span className="secondary">{c.label}</span>
                        <span className="mono muted">{c.cmd}{c.healthyOutput ? <span className="faint"> · {c.healthyOutput}</span> : null}</span>
                        <span className={`mono ${c.singleTarget ? "green-text" : "amber-text"}`}>{c.singleTarget ? "single target" : "no single target"}</span>
                      </div>
                    ))}
                    <div className="crow mono faint">{cm.verification.testGlobs.length > 0 ? `${cm.verification.testGlobs.join(", ")} · ` : ""}max {cm.verification.maxLoopRounds} rounds</div>
                  </>
                ) : (
                  <div className="crow amber-text">no feedback loop — set up verification ("## Verifying your work")</div>
                )}
                <div className="crow mono faint">freshness · {latest ? `last suite run ${latest.startedAt}` : "no suite run yet"}</div>
              </>
            ) : null}
            {warningsFor("CLAUDE.md").map((d, i) => <div className="crow amber-text" key={i}>{d.message}</div>)}
          </section>

          <section aria-label="hooks">
            <div className="section-head"><span className="secondary">Hooks</span><span>managed · engineers cannot switch them off</span></div>
            {snapshot.hooks.length === 0 ? <div className="crow mono faint">no .claude/settings.json</div> : null}
            {snapshot.hooks.map((h) => (
              <div className="crow hooks" key={h.source + h.name + h.matcher}>
                <span className="mono secondary">{h.name}</span>
                <span className="muted">{h.description || h.script}{h.warnings.map((w) => <span className="amber-text block" key={w}>{w}</span>)}</span>
                <span className={`mono ${ACTION_TONE[h.action] ?? "muted"}`}>{h.action} · {h.phase}{h.scope === "managed" ? "" : ` · ${h.scope}`}</span>
              </div>
            ))}
            {harnessHealthy ? (
              <div className="crow mono faint">harness {harnessIds.join(", ")} · every managed guarantee honoured</div>
            ) : (
              <>
                <div className="crow eyebrow">Harness · what runs the sessions and which guarantees it cannot honour</div>
                <table className="bands">
                  <thead><tr><th>Harness</th><th>Session kinds</th><th>Process</th><th>Not honoured — stand-in</th></tr></thead>
                  <tbody>
                    {snapshot.config.harnesses.map((h) => (
                      <tr key={h.id}>
                        <td className="mono">{h.id}</td>
                        <td>{h.jobs.length === 0 ? "all" : h.jobs.join(", ")}</td>
                        <td className="mono">{h.kind === "claude-code" ? `${h.bin ?? "claude"} -p … --mcp-config … --allowedTools …` : [h.command ?? "", ...h.args].join(" ")}</td>
                        <td>{h.degraded.length === 0 ? <span className="green-text">every managed guarantee honoured</span> : h.degraded.map((d) => <div className="warn" key={d.guarantee} title={d.reason}>⚠ {d.guarantee} — {d.reason}</div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="crow mono faint">Hooks not run by the harness are checked by the console where a real check exists (done at exit, plan-sync and test-freeze on the per-change run); production-gate has no in-process stand-in.</div>
              </>
            )}
          </section>

          <section aria-label="skills and subagents">
            <div className="section-head"><span className="secondary">Skills &amp; subagents</span><span>advisory unless a hook backs them · threshold {skillThreshold}%</span></div>
            {snapshot.skillStatus.length === 0 && snapshot.agents.length === 0 ? <div className="crow mono faint">none under .claude/skills or .claude/agents</div> : null}
            {snapshot.skillStatus.map((s) => (
              <div className="crow hooks" key={s.name}>
                <span className="mono secondary">{s.name}{s.version ? ` ${s.version}` : ""}</span>
                <span className="muted">
                  {s.trigger}{s.owner ? ` · ${s.owner}` : ""}{s.mustHold ? " · must hold" : ""}{" · "}
                  {s.backing === "hook" ? <>backed by <span className="green-text">{s.backedBy}</span>{s.backingScope === "managed" ? " · managed" : ""}</> : s.backing === "unknown-hook" ? <span className="red-text" title="named in SKILL.md but not in .claude/settings.json">{s.backedBy} · not installed</span> : <span className={s.mustHoldWithoutHook ? "amber-text" : ""}>advisory{s.mustHoldWithoutHook ? " · must hold without a hook" : ""}</span>}
                </span>
                <span className="mono" title={s.passNote}>
                  {s.passPct === null ? <span className="faint">{s.passNote}</span> : <span className={s.belowThreshold ? "amber-text" : "green-text"}>{s.passPct}%</span>}{s.belowThreshold ? <span className="amber-text"> · not triggering</span> : null}
                  <span className="faint block">{s.triggerTests.active} trigger test{s.triggerTests.active === 1 ? "" : "s"}{s.run ? ` · ${s.run}` : ""} · {s.findingsCiting} findings citing</span>
                </span>
              </div>
            ))}
            {snapshot.agents.map((a) => (
              <div className="crow hooks" key={`agent:${a.name}`}>
                <span className="mono secondary">{a.name}</span>
                <span className="muted">{a.description} · {a.tools.join(", ") || "all tools"}</span>
                <span className="mono faint">{a.model ?? "subagent"}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

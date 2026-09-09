import type { ChangeView } from "@sdlc/core";
import { useEffect, useState } from "react";
import { fetchArtifact, type Artifact } from "../api";
import { ARTIFACT_FILES, ARTIFACT_NAMES, ROLE_LABEL, STAGE_NAMES, barCaption, barClass, ownsGate, prLabel, prNoun, relativeTime, riskLabel, viewerState, waitingFor, type CodeHost, type Role } from "../lib/format";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";
import { HarnessChips } from "./Sessions";

export interface ChangeDetailProps {
  view: ChangeView;
  role: Role;
  /** `config.codeHost` (3.7): names artifact requests "PR #n" on GitHub, "MR !n" on GitLab. */
  codeHost?: CodeHost;
  art: number | null;
  now: Date;
  /** Injected for server-side rendering tests; defaults to the HTTP fetch. */
  loadArtifact?: (id: string, index: number) => Promise<Artifact>;
  onBack: () => void;
  onSelectArt: (index: number) => void;
  onAccept: (gate: number) => void;
  onSendBack: (gate: number, feedback: string) => void;
  /** Post-merge "Add as eval": drafts a case for the platform owner. */
  onHarvest: () => void;
  /** Repro-first (2.7): the build session's reported test awaiting the engineer, from the session registry. */
  reproDraft?: ReproDraftView | null;
  onReproConfirm?: () => void;
  onReproReject?: (reason: string) => void;
  onLiftFreeze?: (path: string, reason: string) => void;
  onDismissAutoFinding?: (path: string, reason: string) => void;
  /** Records mode (FR-16): link the change to its external record; retry a failed write-back for one artifact. */
  onLinkRecord?: (system: string, id: string, url?: string) => void;
  onRetryWriteback?: (artifact: number) => void;
  /** The open inline reason form (rule 3); every reason is typed under the row it belongs to. */
  form: FormState;
  onForm: (form: FormState) => void;
  /** Compliance export (3.3): the API URL the Export link downloads; absent when there is no server. */
  exportHref?: string;
  /** Deployment (3.6): deploy an environment / rehearse its rollback as the viewer; production is the gate's Deploy. */
  onDeploy?: (env: string) => void;
  onRehearse?: (env: string) => void;
  /** The change's sessions from the registry (3.8): one line each with the harness and its unmet guarantees. */
  sessions?: SessionLine[];
}

export interface SessionLine {
  id: string;
  kind: string;
  mode: string;
  status: string;
  startedAt: string;
  harness: { id: string; degraded: { guarantee: string; reason: string }[] } | null;
  standIn: { guarantee: string; allowed: boolean; reason: string; rounds: number } | null;
}

export interface ReproDraftView {
  session: string;
  testPath: string;
  failureReason: string;
  sha: string;
  output: string;
  rejected?: { reason: string; at: string };
}

const STAGE_INDEX = [0, 1, 2, 3, 4, 5];

export function ChangeDetail(p: ChangeDetailProps) {
  const { view, role } = p;
  const selected = p.art ?? view.stage - 1;
  const doc = view.docs[selected as 0 | 1 | 2 | 3 | 4 | 5];
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [busy, setBusy] = useState(false);
  const load = p.loadArtifact ?? fetchArtifact;
  const open = (kind: string, id?: string) => formOpen(p.form, kind, id);
  const close = () => p.onForm(null);
  useEffect(() => {
    let alive = true;
    setArtifact(null);
    if (doc.state === "absent") return;
    void load(view.id, selected).then((a) => {
      if (alive) setArtifact(a);
    });
    return () => {
      alive = false;
    };
  }, [view.id, selected, doc.state, doc.sha, load]);

  const owned = ownsGate(view, role);
  const gate = view.gate;
  const techLead = gate?.mode === "via_pr";
  const selectedPr = view.artifactPrs[selected as 0 | 1 | 2 | 3 | 4 | 5] ?? null;
  const reviewPr = gate ? view.artifactPrs[({ 1: 0, 2: 1, 3: 2, 5: 4, 6: 5 } as const)[gate.s]] ?? null : null;
  const external = STAGE_INDEX.map((i) => view.docs[i as 0 | 1 | 2 | 3 | 4 | 5]).filter((d) => d.record.mode !== "repo");
  const production = view.deploy.productionGate;
  const ownsProduction = production !== null && production.ownerRoles.includes(role);
  const environments = view.deploy.environments;
  const shortSha = (sha: string) => sha.slice(0, 7);
  // "Send back with feedback" is a text link; the reason form opens under it (rule 3)
  const sendBack = gate
    ? open("sendback")
      ? <InlineReason placeholder="Why it goes back — required" submitLabel="Send back" onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onSendBack(gate.s, v["reason"] ?? ""); }} />
      : <button className="btn text" disabled={busy} onClick={() => p.onForm({ kind: "sendback" })}>Send back with feedback</button>
    : null;

  return (
    <div className="detail">
      <button className="back" onClick={p.onBack}>← Pipeline</button>
      <div className="detail-head">
        <span>{view.id} · {STAGE_NAMES[view.stage - 1]}</span>
        <span className={`chip${view.risk === "high" ? " amber" : ""}`}>{riskLabel(view.risk)}</span>
        {view.cycle > 1 ? <span className="chip">cycle {view.cycle}</span> : null}
        {!view.valid ? <span className="chip red">validation error</span> : null}
        {p.exportHref ? <a className="chip" href={p.exportHref} download={`${view.id}-export.json`} title="compliance export: change, every cycle, the ledger verbatim, gate decisions with their commits, PRs, runs and findings — JSON with a sha256 content hash">Export</a> : null}
      </div>
      <h1 className="detail-title">{view.title}</h1>

      <div className="stepper" role="tablist" aria-label="artifacts">
        {STAGE_INDEX.map((i) => {
          const d = view.docs[i as 0 | 1 | 2 | 3 | 4 | 5];
          const isCurrent = view.stage - 1 === i;
          const isPlanDraft = i === 2 && view.planState === "draft";
          return (
            <span key={i} style={{ display: "contents" }}>
              <button className={`step${selected === i ? " selected" : ""}`} role="tab" aria-selected={selected === i} onClick={() => p.onSelectArt(i)}>
                <span className={barClass(d.state, isCurrent, view.agent, isPlanDraft)} />
                <span className="label"><span className="name">{ARTIFACT_NAMES[i]}</span><span className="caption">{barCaption(d.state, isCurrent, view.agent, isPlanDraft, view.planRev)}</span></span>
              </button>
            </span>
          );
        })}
      </div>

      <div className="body">
        <section className="viewer" aria-label="artifact">
          <div className="viewer-head">
            <span className="file">{ARTIFACT_FILES[selected]}</span>
            <span className="chip gray">{viewerState(doc, view)}</span>
            {selectedPr && !selectedPr.merged ? <a className="chip" href={selectedPr.url} target="_blank" rel="noreferrer">{prLabel(p.codeHost, selectedPr.number)}</a> : null}
            {view.record ? (view.record.url ? <a className="chip" href={view.record.url} target="_blank" rel="noreferrer" title="external record">{view.record.system} {view.record.id}</a> : <span className="chip" title="external record">{view.record.system} {view.record.id}</span>) : null}
            {doc.record.writeback && doc.record.writeback.state !== "ok" ? (
              <>
                <span className="chip amber" title={doc.record.writeback.error ?? undefined}>{doc.record.writeback.state === "failed" ? "write-back failed · retry" : "write-back pending"}</span>
                {doc.record.writeback.state === "failed" && p.onRetryWriteback && (role === "eng" || role === "po") ? <button className="btn" disabled={busy} onClick={() => { setBusy(true); p.onRetryWriteback?.(doc.index); }}>Retry</button> : null}
              </>
            ) : null}
          </div>
          {doc.state === "absent" ? (
            <pre className="viewer-body"><span className="viewer-empty">Not committed yet — this artifact is produced when the stage runs.</span></pre>
          ) : artifact === null ? (
            <pre className="viewer-body"><span className="viewer-empty">loading…</span></pre>
          ) : artifact.files ? (
            <pre className="viewer-body">{artifact.files.map((f) => `── ${f.path}\n${f.body}`).join("\n\n")}</pre>
          ) : (
            <pre className="viewer-body">{artifact.body ?? ""}</pre>
          )}
        </section>

        <aside className="rail">
          {gate ? (
            <div className="panel gate">
              <div className="eyebrow">Human gate · {waitingFor(gate.since, p.now)}</div>
              <h3>{gate.label}</h3>
              <div className="who">owner: {gate.ownerLabel}</div>
              {reviewPr ? <div className="who">in review as <a href={reviewPr.url} target="_blank" rel="noreferrer">{prLabel(p.codeHost, reviewPr.number)}</a> · merging it is the decision</div> : null}
              {techLead ? (
                <div className="waiting">Waiting on tech lead — approval happens via {prLabel(p.codeHost)} review on plan.md.{reviewPr ? <> <a href={reviewPr.url} target="_blank" rel="noreferrer">{prLabel(p.codeHost, reviewPr.number)}</a></> : null}</div>
              ) : owned ? (
                <>
                  {view.recordBlock ? <div className="waiting" role="note">{view.recordBlock}</div> : null}
                  <div className="actions">
                    <button className="btn primary" disabled={busy || !view.valid || view.recordBlock !== null} title={view.recordBlock ?? undefined} onClick={() => { setBusy(true); p.onAccept(gate.s); }}>{gate.acceptLabel}</button>
                  </div>
                  {sendBack}
                </>
              ) : (
                <div className="waiting">Waiting on the {gate.ownerLabel} — switch role in the top bar to act.</div>
              )}
              {techLead && role === "eng" ? sendBack : null}
            </div>
          ) : (
            <div className="panel">
              <div className="eyebrow">{view.agent ? <span className="pulse">⌁ </span> : null}No gate open</div>
              <h3>{view.status}</h3>
              <div className="who">{view.waitingOnYou ? `waiting on you: ${view.waitingOnYou}` : "The next human gate opens when the artifact is committed."}</div>
            </div>
          )}
          {external.length > 0 ? (
            <div className="panel records">
              <div className="eyebrow">Record · {view.record ? `${view.record.system} ${view.record.id}` : "none linked"}</div>
              <ul className="activity">
                {external.map((d) => (
                  <li key={d.index}>
                    <span className={`glyph ${d.record.writeback?.state === "failed" ? "system" : "human"}`}>{d.record.writeback?.state === "failed" ? "✗" : d.record.writeback?.state === "pending" ? "…" : d.record.syncedAt ? "✓" : "·"}</span>
                    <span>{d.name} · {d.record.mode}</span>
                    <span className="when">{d.record.writeback && d.record.writeback.state !== "ok" ? `${d.record.writeback.kind} ${d.record.writeback.sha.slice(0, 7)} · ${d.record.writeback.state === "failed" ? "write-back failed · retry" : "write-back pending"}` : d.record.syncedAt ? `synced ${d.record.syncedAt}` : "not synced"}</span>
                  </li>
                ))}
              </ul>
              {!view.record && p.onLinkRecord && (role === "eng" || role === "po") ? (
                open("link-record") ? (
                  <InlineReason placeholder="" submitLabel="Link record" fields={[{ key: "system", placeholder: "Record system (e.g. jira, servicenow)" }, { key: "id", placeholder: "Record id" }, { key: "url", placeholder: "Record URL — optional", required: false }]} onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onLinkRecord?.(v["system"] ?? "", v["id"] ?? "", v["url"] ? v["url"] : undefined); }} />
                ) : (
                  <div className="actions"><button className="btn" disabled={busy} title="change.yaml.record; verified through the records connector when one is configured" onClick={() => p.onForm({ kind: "link-record" })}>Link record</button></div>
                )
              ) : null}
            </div>
          ) : null}
          {view.kind === "fix" && (view.stage === 3 || view.stage === 4 || view.repro) ? (
            <div className="panel repro">
              <div className="eyebrow">Repro first · {view.repro?.state === "committed" ? "freeze active" : p.reproDraft ? (p.reproDraft.rejected ? "sent back" : "waiting on you") : "agent writing the failing test"}</div>
              {view.repro?.state === "committed" ? (
                <>
                  <div className="who">repro test <span className="mono">{view.repro.testPath}</span> committed <span className="mono">{view.repro.sha?.slice(0, 7)}</span> · fails: {view.repro.failureReason}</div>
                  <div className="who">no edits under the test globs until merge{view.freezeLifts.length > 0 ? ` · lifted once for ${view.freezeLifts.map((l) => l.path).join(", ")}` : ""}</div>
                  {role === "eng" && view.stage <= 4 && p.onLiftFreeze ? (
                    open("lift-freeze") ? (
                      <InlineReason placeholder="" submitLabel="Lift freeze" fields={[{ key: "path", placeholder: "Which file — one lift per file per change", ...(view.repro.testPath ? { initial: view.repro.testPath } : {}) }, { key: "reason", placeholder: "Why — required, logged on the ledger" }]} onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onLiftFreeze?.(v["path"] ?? "", v["reason"] ?? ""); }} />
                    ) : (
                      <div className="actions">
                        <button className="btn" disabled={busy} title="one lift per file per change; logged on the ledger" onClick={() => p.onForm({ kind: "lift-freeze" })}>Lift freeze once</button>
                      </div>
                    )
                  ) : null}
                </>
              ) : p.reproDraft ? (
                <>
                  <div className="who"><span className="mono">{p.reproDraft.testPath}</span> · commit <span className="mono">{p.reproDraft.sha.slice(0, 7)}</span> (the test alone) · session {p.reproDraft.session}</div>
                  <div className="who">fails: {p.reproDraft.failureReason}</div>
                  <pre className="viewer-body cmd">{p.reproDraft.output}</pre>
                  {p.reproDraft.rejected ? <div className="chip amber">sent back: {p.reproDraft.rejected.reason} — the session rewrites the test</div> : role === "eng" ? (
                    <div className="actions">
                      <button className="btn primary" disabled={busy} title="commits the repro block and the proof verbatim; the test freeze begins" onClick={() => { setBusy(true); p.onReproConfirm?.(); }}>Fails for the right reason → commit</button>
                      <button className="btn" disabled={busy} onClick={() => p.onForm({ kind: "repro-reject" })}>Wrong failure — send back</button>
                    </div>
                  ) : <div className="waiting">The engineer decides whether this failure is the right one.</div>}
                  {open("repro-reject") ? <InlineReason placeholder="Wrong failure — why? Goes to the session" submitLabel="Send back" onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onReproReject?.(v["reason"] ?? ""); }} /> : null}
                </>
              ) : (
                <div className="who">{view.reproRejection ? `last verdict: wrong failure — ${view.reproRejection.reason}` : "The build session writes the failing test first and reports it; you confirm it fails for the right reason before any code changes."}</div>
              )}
            </div>
          ) : null}
          {view.pr ? (
            <div className="panel pr">
              <div className="eyebrow">{prNoun(view.pr.provider)} · {view.pr.provider}</div>
              <h3>{view.pr.url ? <a href={view.pr.url} target="_blank" rel="noreferrer">{prLabel(view.pr.provider, view.pr.number)} {view.pr.branch}</a> : view.pr.branch}</h3>
              <div className="who">→ {view.pr.baseBranch} · head {view.pr.headSha.slice(0, 7)}{view.pr.mergeSha ? ` · merged ${view.pr.mergeSha.slice(0, 7)}` : ""}</div>
              <ul className="activity">
                {view.pr.checks.map((c) => <li key={c.name}><span className={`glyph ${c.verdict === "pass" ? "human" : "system"}`}>{c.verdict === "pass" ? "✓" : c.verdict === "fail" ? "✗" : "…"}</span><span>{c.name}</span><span className="when">{c.summary ? `${c.verdict} · ${c.summary}` : c.verdict}</span></li>)}
                <li><span className={`glyph ${view.pr.planMatches === false ? "system" : "human"}`}>{view.pr.planMatches === null ? "?" : view.pr.planMatches ? "✓" : "✗"}</span><span>plan matches</span><span className="when">{view.pr.planMatches === null ? "unknown" : view.pr.planMatches ? "yes" : "reviewer judgment"}</span></li>
                {view.pr.findings ? <li><span className="glyph system">·</span><span>findings</span><span className="when">{view.pr.findings.high} high · {view.pr.findings.medium} medium · {view.pr.findings.low} low</span></li> : null}
              </ul>
              {(view.pr.autoFindings ?? []).length > 0 ? (
                <ul className="findings">
                  {(view.pr.autoFindings ?? []).map((f) => (
                    <li key={`${f.rule}:${f.path}`}>
                      <span className={`chip ${f.dismissal ? "gray" : "red"}`}>{f.dismissal ? "dismissed" : "blocks merge"}</span>
                      <span className="title">{f.title}</span>
                      <span className="when">{f.path}</span>
                      <pre className="detail">{f.detail}{f.dismissal ? `\ndismissed by ${f.dismissal.by}: ${f.dismissal.reason}` : ""}</pre>
                      {!f.dismissal && role === "eng" && !view.pr?.mergedAt && p.onDismissAutoFinding ? (
                        open("dismiss-finding", f.path) ? (
                          <InlineReason placeholder={`Why the finding on ${f.path} does not block — required`} submitLabel="Dismiss" onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onDismissAutoFinding?.(f.path, v["reason"] ?? ""); }} />
                        ) : (
                          <div className="actions"><button className="btn" disabled={busy} onClick={() => p.onForm({ kind: "dismiss-finding", id: f.path })}>Dismiss with reason</button></div>
                        )
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {view.pr.reviewers.length > 0 ? <div className="who">reviewers: {view.pr.reviewers.join(", ")}</div> : null}
              <div className="who">
                {view.pr.review
                  ? `review of ${view.pr.review.headSha.slice(0, 7)} · session ${view.pr.review.session}${view.pr.review.afterMerge ? " · ended after the merge" : ""}${view.pr.review.headSha !== view.pr.headSha ? " · head moved since — review pending" : ""}`
                  : view.pr.mergedAt
                    ? "not reviewed by an agent"
                    : "review pending"}
              </div>
              {view.findings.length > 0 ? (
                <ul className="findings">
                  {view.findings.map((f) => (
                    <li key={f.id}>
                      <span className={`chip ${f.severity === "high" ? "red" : f.severity === "medium" ? "amber" : "gray"}`}>{f.severity}</span>
                      <span className="title">{f.title}</span>
                      {f.path ? <span className="when">{f.path}</span> : null}
                      {f.detail ? <pre className="detail">{f.detail}</pre> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {production && (production.open || production.deployment || production.authorized) ? (
            <div className={`panel${production.open ? " gate" : ""}`} aria-label="production gate">
              <div className="eyebrow">Production gate · {production.env}{production.open && production.since ? ` · ${waitingFor(production.since, p.now)}` : ""}</div>
              <h3>{production.deployment?.status === "running" ? `Deploying ${shortSha(production.deployment.sha)} to ${production.env}` : production.deployment?.status === "succeeded" ? `Deployed ${shortSha(production.deployment.sha)} to ${production.env}` : production.deployment?.status === "failed" && !production.open ? `${production.env} deploy failed` : `Deploy ${production.sha ? shortSha(production.sha) : ""} to ${production.env}`}</h3>
              <div className="who">owner: {production.ownerLabel}{production.authorized ? ` · authorized by ${production.authorized.by} ${relativeTime(production.authorized.at, p.now)}` : ""}</div>
              <ul className="activity">
                {production.checks.map((c) => <li key={c.name}><span className={`glyph ${c.verdict === "pass" ? "human" : "system"}`}>{c.verdict === "pass" ? "✓" : c.verdict === "fail" ? "✗" : "…"}</span><span>{c.name}</span><span className="when">{c.verdict}</span></li>)}
              </ul>
              {production.checks.map((c) => <div key={`${c.name}-summary`} className="who">{c.summary}</div>)}
              {production.open ? (
                ownsProduction ? (
                  <>
                    {production.blocked ? <div className="waiting" role="note">{production.blocked}</div> : null}
                    <div className="actions">
                      <button className="btn primary" disabled={busy || !view.valid || production.blocked !== null || !p.onDeploy} title={production.blocked ?? `runs the declared deploy command for ${production.env} after the decision is committed`} onClick={() => { setBusy(true); p.onDeploy?.(production.env); }}>Deploy to {production.env}</button>
                    </div>
                  </>
                ) : (
                  <div className="waiting">Waiting on the {production.ownerLabel} — switch role in the top bar to act.</div>
                )
              ) : null}
              {production.deployment && production.deployment.status !== "running" ? <pre className="viewer-body cmd">{production.deployment.output || "(no output)"}</pre> : null}
            </div>
          ) : null}
          {environments.length > 0 ? (
            <div className="panel environments" aria-label="environments">
              <div className="eyebrow">Environments</div>
              <ul className="activity">
                {environments.map((e) => (
                  <li key={e.name}>
                    <span className={`glyph ${e.status === "succeeded" ? "human" : e.status === "failed" ? "system" : "system"}`}>{e.status === "succeeded" ? "✓" : e.status === "failed" ? "✗" : e.status === "running" ? "…" : "·"}</span>
                    <span>{e.name} <span className="chip gray">{e.kind}</span></span>
                    <span className="when">{e.status === "not-deployed" ? "not deployed" : `${e.status}${e.latest ? ` · ${shortSha(e.latest.sha)} · ${relativeTime(e.latest.finishedAt ?? e.latest.startedAt, p.now)}` : ""}`}{e.rehearsals.length > 0 ? ` · rollback rehearsed ${e.rehearsals.at(-1)?.status}` : ""}</span>
                  </li>
                ))}
              </ul>
              {environments.filter((e) => e.agentDeployable).map((e) => (
                <div key={`${e.name}-detail`} className="env-detail">
                  {e.latest ? <div className="who">{e.name}: {e.latest.command} → exit {e.latest.exitCode ?? "?"} · by {e.latest.actor.type === "agent" ? `⌁ ${e.latest.actor.session ?? e.latest.actor.id}` : e.latest.actor.id}</div> : null}
                  {e.latest && e.latest.status !== "running" ? <pre className="viewer-body cmd">{e.latest.output || "(no output)"}</pre> : null}
                  {e.rehearsals.length > 0 ? (
                    <>
                      <div className="who">rollback rehearsal on {e.name} at {shortSha(e.rehearsals.at(-1)?.sha ?? "")}: {e.rehearsals.at(-1)?.command} → exit {e.rehearsals.at(-1)?.exitCode} · {e.rehearsals.at(-1)?.status}</div>
                      <pre className="viewer-body cmd">{e.rehearsals.at(-1)?.output || "(no output)"}</pre>
                    </>
                  ) : null}
                  {(role === "eng" || role === "po") && (p.onDeploy || p.onRehearse) && view.pr ? (
                    <div className="actions">
                      {p.onDeploy ? <button className="btn" disabled={busy || e.status === "running"} title={`runs the declared deploy command for ${e.name} at ${view.pr.mergeSha ? "the merged commit" : "the PR head"}`} onClick={() => { setBusy(true); p.onDeploy?.(e.name); }}>Deploy to {e.name}</button> : null}
                      {p.onRehearse && e.status === "succeeded" ? <button className="btn" disabled={busy} title={`runs the declared rollback command for ${e.name} at what it has deployed; the record is the production gate's evidence`} onClick={() => { setBusy(true); p.onRehearse?.(e.name); }}>Rehearse rollback</button> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {view.stage === 6 || view.pr?.mergedAt ? (
            <div className="panel">
              <div className="eyebrow">Eval suite</div>
              {view.harvested ? (
                <div className="who">harvested as <span className="mono">{view.harvested.id}</span> <span className={`chip ${view.harvested.status === "active" ? "green" : view.harvested.status === "draft" ? "amber" : "gray"}`}>{view.harvested.status}</span></div>
              ) : (
                <div className="actions"><button className="btn" disabled={busy} onClick={() => { setBusy(true); p.onHarvest(); }} title="draft a case from the intent and the acceptance line; the platform owner activates it">Add as eval</button></div>
              )}
            </div>
          ) : null}
          {!view.valid ? (
            <div className="panel">
              <div className="eyebrow">Validation errors</div>
              <ul className="errors">{view.validationErrors.map((d, i) => <li key={i}>{d.rule}: {d.message}</li>)}</ul>
            </div>
          ) : null}
          {view.planState !== "none" ? (
            <div className="panel">
              <div className="eyebrow">Auto mode</div>
              <div className="who">{view.autoEligible.value ? "eligible" : "not eligible"}</div>
              <ul className="activity">{view.autoEligible.terms.map((t) => <li key={t.name}><span className={`glyph ${t.ok ? "human" : "system"}`}>{t.ok ? "✓" : "✗"}</span><span>{t.name}</span><span className="when">{t.detail}</span></li>)}</ul>
              {view.visual.warning ? <div className="warn">{view.visual.warning}</div> : null}
              {view.visual.mock ? <div className="card-status">mock {view.visual.mock.path.split("/").pop()}{view.visual.tool ? ` · visual tool ${view.visual.tool}` : " · no visual tool in CLAUDE.md"}</div> : null}
            </div>
          ) : null}
          {p.sessions && p.sessions.length > 0 ? (
            <div className="panel">
              <div className="eyebrow">Sessions</div>
              <ul className="activity">
                {p.sessions.map((s) => (
                  <li key={s.id}>
                    <span className="glyph agent">⌁</span>
                    <span><span className="mono">{s.id}</span> · {s.kind} · {s.mode} · {s.status}{s.standIn && !s.standIn.allowed ? ` — ${s.standIn.reason}` : ""} <HarnessChips harness={s.harness} /></span>
                    <span className="when">{relativeTime(s.startedAt, p.now)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="panel">
            <div className="eyebrow">Activity</div>
            <ul className="activity">
              {view.activity.slice(0, 20).map((a) => (
                <li key={a.id}>
                  <span className={`glyph ${a.actor}`}>{a.actor === "agent" ? "⌁" : a.actor === "human" ? "●" : "·"}</span>
                  <span>{a.actor === "human" ? `${a.role ? ROLE_LABEL[a.role as Role] ?? a.role : a.actorId} ` : ""}{a.text}</span>
                  <span className="when">{relativeTime(a.ts, p.now)}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

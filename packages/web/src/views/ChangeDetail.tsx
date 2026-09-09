import type { ChangeView } from "@sdlc/core";
import { useEffect, useState, type ReactNode } from "react";
import { fetchArtifact, type Artifact } from "../api";
import { ARTIFACT_FILES, ARTIFACT_NAMES, ROLE_LABEL, STAGE_NAMES, acceptVerb, barCaption, barClass, ownsGate, prLabel, relativeTime, riskLabel, viewerState, waitingFor, type CodeHost, type Role } from "../lib/format";
import { formOpen, type FormState } from "../state";
import { InlineReason } from "./InlineReason";
import { HarnessWords } from "./Sessions";

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
  /** "Switch role" in the Decision section when the gate is owned by the other role the identity holds; absent when it cannot. */
  onSwitchRole?: () => void;
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
  /** Edits under the frozen test globs the hook blocked (2.7). */
  testEditAttempts?: number;
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

const GLYPH_CLASS = { "✓": "ok", "✗": "bad", "!": "warn", "·": "none" } as const;
type Glyph = keyof typeof GLYPH_CLASS;

/** One evidence row: a glyph in its state colour, a name, an optional verbatim detail, optional text actions, and the inline form that belongs to the row. */
export function EvidenceRow({ glyph, name, detail, actions, form }: { glyph: Glyph; name: ReactNode; detail?: ReactNode; actions?: ReactNode; form?: ReactNode }) {
  return (
    <div className="erow">
      <div className="egrid">
        <span className={`glyph ${GLYPH_CLASS[glyph]}`}>{glyph}</span>
        <span className="ebody">
          <span className="ename">{name}</span>
          {detail ? <span className="edetail">{detail}</span> : null}
        </span>
        {actions ? <span className="eactions">{actions}</span> : null}
      </div>
      {form ? <div className="eform">{form}</div> : null}
    </div>
  );
}

/** One history row: a 6px dot in the actor's colour, the line, the relative time. */
function HistoryRow({ actor, pulse, text, when }: { actor: "agent" | "human" | "system"; pulse?: boolean; text: ReactNode; when: string }) {
  return (
    <div className="hrow">
      <span className={`hdot ${actor}${pulse ? " pulse" : ""}`} />
      <span className="htext">{text}</span>
      <span className="hwhen">{when}</span>
    </div>
  );
}

const verdictGlyph = (v: string): Glyph => (v === "pass" ? "✓" : v === "fail" ? "✗" : "·");
const envGlyph = (status: string): Glyph => (status === "succeeded" ? "✓" : status === "failed" ? "✗" : "·");
const shortSha = (sha: string) => sha.slice(0, 7);

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
  const canAct = role === "eng" || role === "po";
  const merged = view.stage === 6 || Boolean(view.pr?.mergedAt);

  // "Send back with feedback" is a text link; the reason form opens under it (rule 3)
  const sendBack = gate
    ? open("sendback")
      ? <InlineReason placeholder="Why it goes back — required" submitLabel="Send back" onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onSendBack(gate.s, v["reason"] ?? ""); }} />
      : <button className="btn text" disabled={busy} onClick={() => p.onForm({ kind: "sendback" })}>Send back with feedback</button>
    : null;
  const switchRole = p.onSwitchRole ? <> <button className="btn text accent-text" onClick={p.onSwitchRole}>Switch role</button></> : null;

  // ---- Decision: the one open gate (rule 2), lit amber when it is yours; an open production gate *is* the decision ----
  const prodDecides = production !== null && production.open && !gate;
  const decisionEdge = gate ? (owned ? "amber" : "off") : prodDecides ? (ownsProduction ? "amber" : "off") : view.agent ? "agent pulse" : "off";
  const decision = prodDecides && production ? (
    <section className={`rail-section decision edge-lit ${decisionEdge}`} aria-label="decision">
      <div className="eyebrow">Decision{production.since ? ` · ${waitingFor(production.since, p.now)}` : ""}</div>
      <div className="primary">Deploy {production.sha ? shortSha(production.sha) : ""} to {production.env}</div>
      <div className="line">Owned by the {production.ownerLabel}{production.authorized ? ` · authorized by ${production.authorized.by} ${relativeTime(production.authorized.at, p.now)}` : ""}</div>
      <div className="line">{view.status}</div>
      {ownsProduction ? (
        <div className="decide">
          {production.blocked ? <div className="line amber-text" role="note">{production.blocked}</div> : null}
          <button className="btn primary" disabled={busy || !view.valid || production.blocked !== null || !p.onDeploy} title={production.blocked ?? `runs the declared deploy command for ${production.env} after the decision is committed`} onClick={() => { setBusy(true); p.onDeploy?.(production.env); }}>Deploy to {production.env}</button>
        </div>
      ) : (
        <div className="line">Waiting on the {production.ownerLabel}.{switchRole}</div>
      )}
    </section>
  ) : (
    <section className={`rail-section decision edge-lit ${decisionEdge}`} aria-label="decision">
      <div className="eyebrow">{gate ? `Decision · ${waitingFor(gate.since, p.now)}` : "No decision open"}</div>
      <div className="primary">{gate ? gate.label : view.status}</div>
      <div className="line">{gate ? `Owned by the ${gate.ownerLabel}` : view.waitingOnYou ? `Waiting on you: ${view.waitingOnYou}` : "The next decision opens when the artifact is committed."}</div>
      {gate && reviewPr && !techLead ? <div className="line">In review as <a href={reviewPr.url} target="_blank" rel="noreferrer">{prLabel(p.codeHost, reviewPr.number)}</a> · merging it is the decision.</div> : null}
      {gate && techLead ? <div className="line">Approval happens via {prLabel(p.codeHost)} review on plan.md{reviewPr ? <> · <a href={reviewPr.url} target="_blank" rel="noreferrer">{prLabel(p.codeHost, reviewPr.number)}</a></> : null}.</div> : null}
      {gate && owned ? (
        <div className="decide">
          {view.recordBlock ? <div className="line amber-text" role="note">{view.recordBlock}</div> : null}
          <button className="btn primary" disabled={busy || !view.valid || view.recordBlock !== null} title={view.recordBlock ?? undefined} onClick={() => { setBusy(true); p.onAccept(gate.s); }}>{acceptVerb(view, p.codeHost)}</button>
          {sendBack}
        </div>
      ) : gate && !techLead ? (
        <div className="line">Waiting on the {gate.ownerLabel}.{switchRole}</div>
      ) : null}
      {gate && techLead && role === "eng" ? <div className="decide">{sendBack}</div> : null}
    </section>
  );

  // ---- Evidence: state rows, in the order the panels used to stack ----
  const evidence: ReactNode[] = [];
  const row = (key: string, glyph: Glyph, name: ReactNode, detail?: ReactNode, actions?: ReactNode, form?: ReactNode) => evidence.push(<EvidenceRow key={key} glyph={glyph} name={name} detail={detail} actions={actions} form={form} />);

  // 1 · auto-mode terms
  if (view.planState !== "none") {
    row("auto", "·", `auto mode · ${view.autoEligible.value ? "eligible" : "not eligible"}`);
    for (const t of view.autoEligible.terms) row(`auto:${t.name}`, t.ok ? "✓" : "✗", t.name, t.detail);
    if (view.visual.warning) row("visual", "!", "visual check", view.visual.warning);
    if (view.visual.mock) row("mock", "·", `mock ${view.visual.mock.path.split("/").pop()}`, view.visual.tool ? `visual tool ${view.visual.tool}` : "no visual tool in CLAUDE.md");
  }

  // 2 · repro first (fix changes)
  if (view.kind === "fix" && (view.stage === 3 || view.stage === 4 || view.repro)) {
    const draft = p.reproDraft;
    if (view.repro?.state === "committed") {
      const lifts = view.freezeLifts.length > 0 ? ` · lifted once for ${view.freezeLifts.map((l) => l.path).join(", ")}` : "";
      const canLift = role === "eng" && view.stage <= 4 && p.onLiftFreeze;
      row(
        "repro",
        "✓",
        "repro test frozen",
        `${view.repro.testPath ?? ""} · ${shortSha(view.repro.sha ?? "")} · fails: ${view.repro.failureReason ?? ""} · no edits under the test globs until merge${lifts}`,
        canLift && !open("lift-freeze") ? <button className="btn text" disabled={busy} title="one lift per file per change; logged on the ledger" onClick={() => p.onForm({ kind: "lift-freeze" })}>Lift freeze once</button> : null,
        canLift && open("lift-freeze") ? <InlineReason placeholder="" submitLabel="Lift freeze" fields={[{ key: "path", placeholder: "Which file — one lift per file per change", ...(view.repro.testPath ? { initial: view.repro.testPath } : {}) }, { key: "reason", placeholder: "Why — required, logged on the ledger" }]} onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onLiftFreeze?.(v["path"] ?? "", v["reason"] ?? ""); }} /> : null,
      );
      const blocked = (p.sessions ?? []).reduce((n, s) => n + (s.testEditAttempts ?? 0), 0);
      if (blocked > 0) row("test-edits", "✗", "test edit attempts", `${blocked} blocked by test-freeze`);
    } else if (draft && draft.rejected) {
      row("repro", "!", "repro test sent back", `${draft.testPath} · ${draft.rejected.reason} — the session rewrites the test`);
    } else if (draft) {
      row(
        "repro",
        "!",
        "repro test reported",
        <>{draft.testPath} · {shortSha(draft.sha)} (the test alone) · session {draft.session} · fails: {draft.failureReason}<pre>{draft.output}</pre></>,
        role === "eng" ? <button className="btn text" disabled={busy} title="commits the repro block and the proof verbatim; the test freeze begins" onClick={() => { setBusy(true); p.onReproConfirm?.(); }}>Fails for the right reason → commit</button> : null,
      );
      row(
        "repro-verdict",
        "·",
        role === "eng" ? "not the right failure?" : "the engineer decides whether this failure is the right one",
        undefined,
        role === "eng" && !open("repro-reject") ? <button className="btn text" disabled={busy} onClick={() => p.onForm({ kind: "repro-reject" })}>Wrong failure — send back</button> : null,
        role === "eng" && open("repro-reject") ? <InlineReason placeholder="Wrong failure — why? Goes to the session" submitLabel="Send back" onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onReproReject?.(v["reason"] ?? ""); }} /> : null,
      );
    } else {
      row("repro", "·", "repro first", view.reproRejection ? `last verdict: wrong failure — ${view.reproRejection.reason}` : "the build session writes the failing test first and reports it; you confirm it fails for the right reason before any code changes");
    }
  }

  // 3 · pull request: checks, plan match, findings, review
  if (view.pr) {
    const pr = view.pr;
    row("pr", "·", pr.url ? <a href={pr.url} target="_blank" rel="noreferrer">{prLabel(pr.provider, pr.number)} {pr.branch}</a> : pr.branch, `→ ${pr.baseBranch} · head ${shortSha(pr.headSha)}${pr.mergeSha ? ` · merged ${shortSha(pr.mergeSha)}` : ""} · ${pr.provider}`);
    for (const c of pr.checks) row(`check:${c.name}`, verdictGlyph(c.verdict), c.name, c.summary ? `${c.verdict} · ${c.summary}` : c.verdict);
    row("plan-matches", pr.planMatches === false ? "✗" : pr.planMatches === null ? "·" : "✓", "plan matches", pr.planMatches === null ? "unknown" : pr.planMatches ? "yes" : "reviewer judgment");
    if (pr.findings) row("findings", pr.findings.high > 0 ? "!" : "·", "findings", `${pr.findings.high} high · ${pr.findings.medium} medium · ${pr.findings.low} low`);
    for (const f of pr.autoFindings ?? []) {
      const dismissable = !f.dismissal && role === "eng" && !pr.mergedAt && p.onDismissAutoFinding;
      row(
        `auto-finding:${f.rule}:${f.path}`,
        f.dismissal ? "·" : "✗",
        f.dismissal ? `${f.title} · dismissed` : `${f.title} · blocks merge`,
        <>{f.path}<pre>{f.detail}{f.dismissal ? `\ndismissed by ${f.dismissal.by}: ${f.dismissal.reason}` : ""}</pre></>,
        dismissable && !open("dismiss-finding", f.path) ? <button className="btn text" disabled={busy} onClick={() => p.onForm({ kind: "dismiss-finding", id: f.path })}>Dismiss</button> : null,
        dismissable && open("dismiss-finding", f.path) ? <InlineReason placeholder={`Why the finding on ${f.path} does not block — required`} submitLabel="Dismiss" onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onDismissAutoFinding?.(f.path, v["reason"] ?? ""); }} /> : null,
      );
    }
    if (pr.reviewers.length > 0) row("reviewers", "·", "reviewers", pr.reviewers.join(", "));
    const reviewLine = pr.review
      ? `review of ${shortSha(pr.review.headSha)} · session ${pr.review.session}${pr.review.afterMerge ? " · ended after the merge" : ""}${pr.review.headSha !== pr.headSha ? " · head moved since — review pending" : ""}`
      : pr.mergedAt
        ? "not reviewed by an agent"
        : "review pending";
    const n = view.findings.length;
    row(
      "review",
      view.findings.some((f) => f.severity !== "low") ? "!" : "·",
      `review · ${n} finding${n === 1 ? "" : "s"}`,
      <>
        {reviewLine}
        {view.findings.map((f) => (
          <span key={f.id} className="finding">
            {f.severity} · {f.title}{f.path ? ` · ${f.path}` : ""}
            {f.detail ? <pre>{f.detail}</pre> : null}
          </span>
        ))}
      </>,
    );
  }

  // 4 · environments and the production gate
  for (const e of environments) {
    const last = e.rehearsals.at(-1);
    const state = e.status === "not-deployed" ? `not deployed${e.kind === "production" ? " · gated after merge" : ""}` : `${e.status}${e.latest ? ` · ${shortSha(e.latest.sha)} · ${relativeTime(e.latest.finishedAt ?? e.latest.startedAt, p.now)}` : ""}${last ? ` · rollback rehearsed ${last.status}` : ""}`;
    const detail = e.agentDeployable && e.latest ? (
      <>
        {state}
        <span className="finding">{e.latest.command} → exit {e.latest.exitCode ?? "?"} · by {e.latest.actor.type === "agent" ? e.latest.actor.session ?? e.latest.actor.id : e.latest.actor.id}</span>
        {e.latest.status !== "running" ? <pre>{e.latest.output || "(no output)"}</pre> : null}
        {last ? <><span className="finding">rollback rehearsal at {shortSha(last.sha)}: {last.command} → exit {last.exitCode} · {last.status}</span><pre>{last.output || "(no output)"}</pre></> : null}
      </>
    ) : state;
    const actions = e.agentDeployable && canAct && (p.onDeploy || p.onRehearse) && view.pr ? (
      <>
        {p.onDeploy ? <button className="btn text" disabled={busy || e.status === "running"} title={`runs the declared deploy command for ${e.name} at ${view.pr.mergeSha ? "the merged commit" : "the PR head"}`} onClick={() => { setBusy(true); p.onDeploy?.(e.name); }}>Deploy to {e.name}</button> : null}
        {p.onRehearse && e.status === "succeeded" ? <button className="btn text" disabled={busy} title={`runs the declared rollback command for ${e.name} at what it has deployed; the record is the production gate's evidence`} onClick={() => { setBusy(true); p.onRehearse?.(e.name); }}>Rehearse rollback</button> : null}
      </>
    ) : null;
    row(`env:${e.name}`, envGlyph(e.status), `${e.name} · ${e.kind}`, detail, actions);
  }
  if (production && !prodDecides && (production.open || production.deployment || production.authorized)) {
    const d = production.deployment;
    const title = d?.status === "running" ? `Deploying ${shortSha(d.sha)} to ${production.env}` : d?.status === "succeeded" ? `Deployed ${shortSha(d.sha)} to ${production.env}` : d?.status === "failed" && !production.open ? `${production.env} deploy failed` : `Deploy ${production.sha ? shortSha(production.sha) : ""} to ${production.env}`;
    row(
      "production-gate",
      d?.status === "succeeded" ? "✓" : d?.status === "failed" ? "✗" : production.open ? "!" : "·",
      `Production gate · ${production.env}`,
      <>
        {title} · owner: {production.ownerLabel}{production.authorized ? ` · authorized by ${production.authorized.by} ${relativeTime(production.authorized.at, p.now)}` : ""}{production.open && production.since ? ` · ${waitingFor(production.since, p.now)}` : ""}
        {production.open && !ownsProduction ? <span className="finding">Waiting on the {production.ownerLabel}.</span> : null}
        {production.open && ownsProduction && production.blocked ? <span className="finding amber-text">{production.blocked}</span> : null}
        {d && d.status !== "running" ? <pre>{d.output || "(no output)"}</pre> : null}
      </>,
      production.open && ownsProduction ? <button className="btn text" disabled={busy || !view.valid || production.blocked !== null || !p.onDeploy} title={production.blocked ?? `runs the declared deploy command for ${production.env} after the decision is committed`} onClick={() => { setBusy(true); p.onDeploy?.(production.env); }}>Deploy to {production.env}</button> : null,
    );
  }
  if (production && (production.open || production.deployment || production.authorized)) {
    for (const c of production.checks) row(`prod-check:${c.name}`, verdictGlyph(c.verdict), c.name, `${c.verdict} · ${c.summary}`);
  }

  // 5 · record: the external record and each artifact's sync
  if (view.record || external.length > 0) {
    const canLink = !view.record && p.onLinkRecord && canAct;
    row(
      "record",
      "·",
      <>record · {view.record ? (view.record.url ? <a href={view.record.url} target="_blank" rel="noreferrer">{view.record.system} {view.record.id}</a> : `${view.record.system} ${view.record.id}`) : "none linked"}</>,
      undefined,
      canLink && !open("link-record") ? <button className="btn text" disabled={busy} title="change.yaml.record; verified through the records connector when one is configured" onClick={() => p.onForm({ kind: "link-record" })}>Link record</button> : null,
      canLink && open("link-record") ? <InlineReason placeholder="" submitLabel="Link record" fields={[{ key: "system", placeholder: "Record system (e.g. jira, servicenow)" }, { key: "id", placeholder: "Record id" }, { key: "url", placeholder: "Record URL — optional", required: false }]} onCancel={close} onSubmit={(v) => { setBusy(true); close(); p.onLinkRecord?.(v["system"] ?? "", v["id"] ?? "", v["url"] ? v["url"] : undefined); }} /> : null,
    );
    for (const d of external) {
      const wb = d.record.writeback && d.record.writeback.state !== "ok" ? d.record.writeback : null;
      row(
        `record:${d.index}`,
        wb ? (wb.state === "failed" ? "✗" : "·") : d.record.syncedAt ? "✓" : "·",
        `${d.name} · ${d.record.mode}`,
        wb ? `${wb.kind} ${shortSha(wb.sha)} · ${wb.state === "failed" ? `write-back failed${wb.error ? `: ${wb.error}` : ""}` : "write-back pending"}` : d.record.syncedAt ? `synced ${d.record.syncedAt}` : "not synced",
        wb?.state === "failed" && p.onRetryWriteback && canAct ? <button className="btn text" disabled={busy} onClick={() => { setBusy(true); p.onRetryWriteback?.(d.index); }}>Retry</button> : null,
      );
    }
  }
  if (selectedPr && !selectedPr.merged) row("artifact-pr", "·", <><a href={selectedPr.url} target="_blank" rel="noreferrer">{prLabel(p.codeHost, selectedPr.number)}</a> · {ARTIFACT_FILES[selected]} in review</>, selectedPr.branch);

  // 6 · eval suite: harvested case, stale runs
  if (merged && view.harvested) row("harvested", view.harvested.status === "active" ? "✓" : "·", <>harvested as <span className="mono">{view.harvested.id}</span></>, view.harvested.status);
  if (view.evalsState === "stale" && view.latestRun) row("evals-stale", "!", "evals stale", `since ${view.latestRun.startedAt} · config changed after the run`);

  // 7 · validation
  for (const [i, d] of view.validationErrors.entries()) row(`validation:${i}`, "✗", `validation · ${d.rule}`, d.message);

  // ---- History: sessions first, then the ledger, newest first ----
  const firstAgent = view.activity.findIndex((a) => a.actor === "agent");
  const history = (
    <section className="rail-section" aria-label="history">
      <div className="section-head">History</div>
      {(p.sessions ?? []).map((s) => (
        <HistoryRow key={s.id} actor="agent" pulse={s.status === "running"} text={<><span className="mono">{s.id}</span> · {s.kind} · {s.mode} · {s.status}{s.standIn && !s.standIn.allowed ? ` — ${s.standIn.reason}` : ""} <HarnessWords harness={s.harness} /></>} when={relativeTime(s.startedAt, p.now)} />
      ))}
      {view.activity.slice(0, 20).map((a, i) => (
        <HistoryRow key={a.id} actor={a.actor} pulse={a.actor === "agent" && view.agent && i === firstAgent} text={<>{a.actor === "human" ? `${a.role ? ROLE_LABEL[a.role as Role] ?? a.role : a.actorId} ` : ""}{a.text}</>} when={relativeTime(a.ts, p.now)} />
      ))}
      <div className="section-foot">
        {merged && !view.harvested ? <button className="btn text" disabled={busy} onClick={() => { setBusy(true); p.onHarvest(); }} title="draft a case from the intent and the acceptance line; the platform owner activates it">Add as eval</button> : null}
        {p.exportHref ? <a className="btn text" href={p.exportHref} download={`${view.id}-export.json`} title="compliance export: change, every cycle, the ledger verbatim, gate decisions with their commits, PRs, runs and findings — JSON with a sha256 content hash">Export ledger</a> : null}
      </div>
    </section>
  );

  return (
    <div className="detail">
      <div className="detail-head">
        <span><button className="btn text mono" onClick={p.onBack}>Pipeline</button> · {view.id} · {STAGE_NAMES[view.stage - 1]}{view.risk === "high" ? <> · <span className="amber-text">{riskLabel(view.risk)}</span></> : null}{view.cycle > 1 ? ` · cycle ${view.cycle}` : ""}</span>
        {!view.valid ? <span className="chip red">validation error</span> : null}
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
            <span className="state">{viewerState(doc, view)}</span>
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
          {decision}
          {evidence.length > 0 ? (
            <section className="rail-section" aria-label="evidence">
              <div className="section-head">Evidence</div>
              {evidence}
            </section>
          ) : null}
          {history}
        </aside>
      </div>
    </div>
  );
}

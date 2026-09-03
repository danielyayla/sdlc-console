import type { Change, Diagnostic, Event, EvalCase, GateNumber, PerChangeRun, Pr, RecordsMode } from "@sdlc/schemas";
import { activityFeed, type ActivityEntry } from "./activity.js";
import { deriveEligibility, type Eligibility } from "./eligibility.js";
import { eventsNamed, eventsOfCycle, firstEvent, indexOf, lastEvent, latestOf } from "./events.js";
import { fingerprintMatches } from "./fingerprint.js";
import type { ChangeFiles, Repo } from "./repo.js";
import {
  ARTIFACT_INDEX_FOR_GATE,
  ROLE_LABELS,
  STAGES,
  gateOwner,
  stageDef,
  type ArtifactIndex,
  type GateMode,
  type GateRole,
  type StageNumber,
} from "./stages.js";

export type DocState = "absent" | "draft" | "pending-review" | "committed" | "stale";

export interface DocView {
  index: ArtifactIndex;
  name: string;
  path: string;
  state: DocState;
  sha: string | null;
  sourceOfTruth: RecordsMode;
  authoritative: boolean;
}

export interface GateView {
  s: GateNumber;
  label: string;
  ownerRole: GateRole;
  ownerLabel: string;
  acceptLabel: "Accept" | "Merge";
  mode: GateMode;
  /** ISO time the gate opened (artifact committed / PR opened). */
  since: string;
}

export type EvalsState = "not-run" | "running" | "green" | "red" | "waiting" | "stale";

export interface ChangeView {
  id: string;
  title: string;
  kind: Change["kind"];
  risk: Change["risk"];
  cycle: number;
  origin: Change["origin"];
  record: Change["record"];
  repro: Change["repro"];
  closed: Change["closed"];
  createdAt: string;
  stage: StageNumber;
  stageName: string;
  gate: GateView | null;
  agent: boolean;
  status: string;
  docs: Record<ArtifactIndex, DocView>;
  planRev: number;
  planState: "none" | "draft" | "committed";
  planMatches: boolean | null;
  planFiles: string[];
  acceptanceLine: string | null;
  autoEligible: Eligibility;
  acceptedGates: GateNumber[];
  evalsState: EvalsState;
  latestRun: PerChangeRun | null;
  intersectingCases: string[];
  pr: Pr | null;
  waitingOnYou: string | null;
  activity: ActivityEntry[];
  tasks: NonNullable<ChangeFiles["tasks"]>["tasks"];
  validationErrors: Diagnostic[];
  valid: boolean;
}

export interface StageInputs {
  acceptedGates: ReadonlySet<number>;
  greenRunMatchesConfig: boolean;
  prMerged: boolean;
}

/** Stage is a pure function of accepted gates + eval verdict + merge (docs/storage-layout.md). */
export function deriveStage(i: StageInputs): StageNumber {
  if (!i.acceptedGates.has(1)) return 1;
  if (!i.acceptedGates.has(2)) return 2;
  if (!i.acceptedGates.has(3)) return 3;
  if (!i.greenRunMatchesConfig) return 4;
  if (!i.prMerged) return 5;
  return 6;
}

function err(path: string, rule: string, message: string): Diagnostic {
  return { path, severity: "error", rule, message };
}

/** Active eval cases whose paths intersect the plan's file set (Stage 04 inputs). */
export function intersectingCases(planFiles: readonly string[], cases: readonly EvalCase[]): EvalCase[] {
  if (planFiles.length === 0) return [];
  return cases.filter((c) => c.status === "active" && c.paths.some((p) => planFiles.includes(p)));
}

/**
 * Derive one change's view from its files and the repo context. Never throws;
 * inconsistent inputs produce `validationErrors` and `valid=false`, and an
 * invalid change has no open gate so it drops out of every queue.
 */
export function deriveChange(repo: Repo, files: ChangeFiles): ChangeView {
  const errors: Diagnostic[] = files.diagnostics.filter((d) => d.severity === "error");
  const change = files.change;
  const dir = files.dir;

  if (!change) {
    return invalidView(files, errors);
  }

  const events = eventsOfCycle(files.events, change.cycle);
  const accepted = new Set<GateNumber>();
  for (const e of eventsNamed(events, "gate.accepted")) accepted.add(e.data.gate);

  // ---- consistency checks that make derivation meaningful ----
  if (accepted.has(6)) {
    errors.push(err(`${dir}/log.jsonl`, "loop.not-applied", `gate 6 accepted in cycle ${change.cycle} but change.yaml still says cycle ${change.cycle}`));
  }
  const order: GateNumber[] = [1, 2, 3, 5, 6];
  for (let k = 1; k < order.length; k++) {
    const g = order[k];
    const prev = order[k - 1];
    if (g !== undefined && prev !== undefined && accepted.has(g) && !accepted.has(prev)) {
      errors.push(err(`${dir}/log.jsonl`, "gate.out-of-order", `gate ${g} accepted before gate ${prev}`));
    }
  }
  if (accepted.has(1) && !files.present.intent) errors.push(err(`${dir}/intent.md`, "artifact.missing", "gate 1 accepted but intent.md is missing"));
  if (accepted.has(2) && !files.present.spec) errors.push(err(`${dir}/spec.md`, "artifact.missing", "gate 2 accepted but spec.md is missing"));
  if (accepted.has(3) && !files.present.plan) errors.push(err(`${dir}/plan.md`, "artifact.missing", "gate 3 accepted but plan.md is missing"));
  if (change.risk === "high" && accepted.has(3)) {
    const acc3 = lastEvent(events, "gate.accepted", (e) => e.data.gate === 3);
    if (acc3 && acc3.data.source !== "pr.merge") {
      errors.push(err(`${dir}/log.jsonl`, "gate3.high-risk.source", "high-risk plan accepted outside a PR merge"));
    }
  }
  const dupIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const e of files.events) {
    if (seenIds.has(e.id)) dupIds.add(e.id);
    seenIds.add(e.id);
  }

  // ---- evals / stage ----
  const runsThisCycle = files.runs.filter((r) => r.cycle === change.cycle);
  const latestRun = runsThisCycle.at(-1) ?? null;
  const greenMatching = runsThisCycle.some((r) => r.verdict === "green" && fingerprintMatches(r.configRef, repo.fingerprint));
  const prMerged = files.pr?.mergedAt !== undefined || lastEvent(events, "pr.merged") !== null;
  const stage = deriveStage({ acceptedGates: accepted, greenRunMatchesConfig: greenMatching, prMerged });
  if (stage === 5 && !files.present.pr) {
    errors.push(err(`${dir}/pr.yaml`, "pr.missing", "evals are green but pr.yaml is missing"));
  }

  // ---- gate ----
  const stageInfo = stageDef(stage);
  let gate: GateView | null = null;
  let sentBackJustNow = false;
  let planIsFinal = true;
  if (stageInfo.gate !== null) {
    const g = stageInfo.gate;
    const idx = ARTIFACT_INDEX_FOR_GATE[g];
    const present = g === 5 ? files.present.pr : g === 6 ? files.present.incident : g === 3 ? files.present.plan : g === 2 ? files.present.spec : files.present.intent;
    const committed = lastEvent(events, "artifact.committed", (e) => e.data.artifact === idx);
    const sentBack = lastEvent(events, "gate.sent_back", (e) => e.data.gate === g);
    const planFinal = g === 3 ? lastEvent(events, "plan.final") : null;
    const planDrafted = g === 3 ? lastEvent(events, "plan.drafted") : null;
    const prOpened = g === 5 ? lastEvent(events, "pr.opened") : null;
    const latest = latestOf(events, [committed, sentBack, planFinal, planDrafted, prOpened]);
    let open = false;
    let since = change.created.at;
    if (present) {
      if (latest === null) {
        open = true;
      } else if (latest.event === "gate.sent_back") {
        open = false;
        sentBackJustNow = true;
      } else if (latest.event === "plan.drafted") {
        open = false;
        planIsFinal = false;
      } else {
        open = true;
      }
      since = g === 5 ? (files.pr?.openedAt ?? prOpened?.ts ?? since) : (latest?.event === "gate.sent_back" ? since : (latest?.ts ?? since));
    }
    if (open) {
      const owner = gateOwner(g, change.risk, files.pr?.provider ?? "local");
      const def = { 1: "Accept", 2: "Accept", 3: "Accept", 5: "Merge", 6: "Accept" }[g] as "Accept" | "Merge";
      gate = { s: g, label: owner.label, ownerRole: owner.role, ownerLabel: ROLE_LABELS[owner.role], acceptLabel: def, mode: owner.mode, since };
    }
  }

  // ---- docs ----
  const docs = deriveDocs(repo, files, events, accepted, stage, gate, greenMatching, prMerged);

  // ---- plan ----
  const planRev = files.plan?.frontMatter.rev ?? (lastEvent(events, "plan.drafted")?.data.rev ?? 0);
  const planState: ChangeView["planState"] = !files.present.plan ? "none" : accepted.has(3) ? "committed" : "draft";
  const planSync = latestOf(events, [
    lastEvent(events, "hook.blocked", (e) => e.data.hook === "plan-sync"),
    lastEvent(events, "hook.allowed", (e) => e.data.hook === "plan-sync"),
  ]);
  const planMatches: boolean | null = planSync ? planSync.event === "hook.allowed" : (files.pr?.planMatches ?? null);
  const planFiles = files.plan?.files.map((f) => f.path) ?? [];

  // ---- evals state / status ----
  const cases = intersectingCases(planFiles, repo.evalCases);
  let evalsState: EvalsState = "not-run";
  let waitingOnYou: string | null = null;
  if (stage === 4) {
    if (runsThisCycle.length === 0) evalsState = "running";
    else if (greenMatching) evalsState = "green";
    else if (latestRun?.verdict === "green") evalsState = "stale";
    else {
      let reds = 0;
      for (let i = runsThisCycle.length - 1; i >= 0 && runsThisCycle[i]?.verdict === "red"; i--) reds++;
      evalsState = reds >= 2 ? "waiting" : "red";
      if (reds >= 2) waitingOnYou = "evals red twice";
    }
  } else if (stage > 4) {
    evalsState = "green";
  }

  const autoEligible = deriveEligibility({
    specCommitted: accepted.has(2),
    risk: change.risk,
    planFiles: files.plan ? planFiles : null,
    activeCases: repo.evalCases.filter((c) => c.status === "active"),
    verification: repo.verification,
    config: repo.config,
  });

  const { agent, status } = deriveStatus({
    change,
    stage,
    gate,
    sentBackJustNow,
    planIsFinal,
    evalsState,
    cases: cases.length,
    present: files.present,
    planRev,
    fresh: files.archivedCycles.length > 0 && !files.present.intent,
  });

  const valid = errors.length === 0;
  return {
    id: change.id,
    title: change.title,
    kind: change.kind,
    risk: change.risk,
    cycle: change.cycle,
    origin: change.origin,
    record: change.record,
    repro: change.repro,
    closed: change.closed,
    createdAt: change.created.at,
    stage,
    stageName: stageInfo.name,
    gate: valid && !change.closed ? gate : null,
    agent: valid && !change.closed ? agent : false,
    status: !valid ? "validation error — fix the files to re-enter the queue" : change.closed ? `Closed — ${change.closed.reason}` : status,
    docs,
    planRev,
    planState,
    planMatches,
    planFiles,
    acceptanceLine: files.plan?.acceptanceLine ?? null,
    autoEligible,
    acceptedGates: [...accepted].sort((a, b) => a - b),
    evalsState,
    latestRun,
    intersectingCases: cases.map((c) => c.id),
    pr: files.pr,
    waitingOnYou,
    activity: activityFeed(files.events),
    tasks: files.tasks?.tasks ?? [],
    validationErrors: errors,
    valid,
  };
}

function invalidView(files: ChangeFiles, errors: Diagnostic[]): ChangeView {
  const docs = {} as Record<ArtifactIndex, DocView>;
  for (const s of STAGES) {
    docs[s.artifactIndex] = { index: s.artifactIndex, name: s.file, path: `${files.dir}/${s.file}`, state: "absent", sha: null, sourceOfTruth: "repo", authoritative: true };
  }
  return {
    id: files.id,
    title: files.id,
    kind: "feature",
    risk: "routine",
    cycle: 1,
    origin: { type: "idea" },
    record: null,
    repro: null,
    closed: null,
    createdAt: "",
    stage: 1,
    stageName: "Plan",
    gate: null,
    agent: false,
    status: "validation error — change.yaml unreadable",
    docs,
    planRev: 0,
    planState: "none",
    planMatches: null,
    planFiles: [],
    acceptanceLine: null,
    autoEligible: { value: false, terms: [] },
    acceptedGates: [],
    evalsState: "not-run",
    latestRun: null,
    intersectingCases: [],
    pr: null,
    waitingOnYou: null,
    activity: activityFeed(files.events),
    tasks: [],
    validationErrors: errors,
    valid: false,
  };
}

function deriveDocs(
  repo: Repo,
  files: ChangeFiles,
  events: Event[],
  accepted: ReadonlySet<GateNumber>,
  stage: StageNumber,
  gate: GateView | null,
  greenMatching: boolean,
  prMerged: boolean,
): Record<ArtifactIndex, DocView> {
  const docs = {} as Record<ArtifactIndex, DocView>;
  for (const s of STAGES) {
    const idx = s.artifactIndex;
    const present = files.present[s.artifact];
    const mode = repo.config.records[s.artifact];
    let state: DocState = "absent";
    if (present) {
      const gateOpen = gate?.s === s.gate;
      if (s.n === 4) {
        state = greenMatching || stage > 4 ? "committed" : "draft";
      } else if (s.n === 5) {
        state = prMerged ? "committed" : gateOpen ? "pending-review" : "draft";
      } else if (s.gate !== null && accepted.has(s.gate)) {
        state = "committed";
        // stale: artifact re-committed after its acceptance
        const acc = lastEvent(events, "gate.accepted", (e) => e.data.gate === s.gate);
        const recommit = lastEvent(events, "artifact.committed", (e) => e.data.artifact === idx);
        if (acc && recommit && indexOf(events, recommit) > indexOf(events, acc)) state = "stale";
        // stale: edited after the next artifact's first commit
        const nextFirst = firstEvent(events, "artifact.committed", (e) => e.data.artifact === idx + 1);
        if (recommit && nextFirst && indexOf(events, recommit) > indexOf(events, nextFirst)) state = "stale";
      } else {
        state = gateOpen ? "pending-review" : "draft";
      }
    }
    const shaKey = s.file as keyof ChangeFiles["shas"];
    docs[idx] = {
      index: idx,
      name: s.n === 4 ? "evals" : s.file,
      path: `${files.dir}/${s.file}`,
      state,
      sha: s.n === 4 ? null : (files.shas[shaKey] ?? null),
      sourceOfTruth: mode,
      authoritative: mode === "repo",
    };
  }
  return docs;
}

interface StatusInputs {
  change: Change;
  stage: StageNumber;
  gate: GateView | null;
  sentBackJustNow: boolean;
  planIsFinal: boolean;
  evalsState: EvalsState;
  cases: number;
  present: ChangeFiles["present"];
  planRev: number;
  fresh: boolean;
}

/** `agent` flag and status text per spec §5 / §4. */
function deriveStatus(i: StatusInputs): { agent: boolean; status: string } {
  const s = stageDef(i.stage);
  const artifact = s.n === 4 ? "evals" : s.file;
  if (i.gate) {
    if (i.stage === 1 && i.change.origin.type === "triage") return { agent: false, status: `Intent drafted via ${i.change.origin.ref ?? "triage"}` };
    if (i.stage === 1 && i.change.origin.type === "security") return { agent: false, status: `Intent drafted via ${i.change.origin.ref ?? "security finding"}` };
    if (i.gate.mode === "via_pr") return { agent: false, status: `${artifact} awaiting tech lead — approval via PR review` };
    return { agent: false, status: `${artifact} committed — waiting on the ${i.gate.ownerLabel}` };
  }
  if (i.sentBackJustNow) return { agent: true, status: `Agent revising ${artifact} per feedback` };
  switch (i.stage) {
    case 1:
      if (i.fresh || (i.change.cycle > 1 && !i.present.intent)) return { agent: true, status: "Loop closed — re-entered Plan from incident" };
      return { agent: true, status: "Agent producing intent.md" };
    case 2:
      return { agent: true, status: "Agent producing spec.md" };
    case 3:
      if (i.present.plan && !i.planIsFinal) return { agent: true, status: `Agent drafting plan.md · rev ${i.planRev}` };
      return { agent: true, status: "Agent producing plan.md" };
    case 4:
      switch (i.evalsState) {
        case "red":
          return { agent: true, status: "Evals red — agent fixing" };
        case "waiting":
          return { agent: false, status: "waiting on you: evals red twice" };
        case "stale":
          return { agent: true, status: "Evals green on an older config — rerun needed" };
        default:
          return { agent: true, status: i.cases > 0 ? `Evals running · ${i.cases} case${i.cases === 1 ? "" : "s"}` : "Building — verification pending" };
      }
    case 5:
      return { agent: true, status: "Opening PR" };
    case 6:
      return { agent: false, status: i.present.incident ? "Incident recorded" : "Deployed · monitoring" };
  }
}

export interface Snapshot {
  changes: ChangeView[];
  triage: Repo["triage"];
  findings: Repo["findings"];
  proposals: Repo["proposals"];
  evalCases: Repo["evalCases"];
  evalRuns: Repo["evalRuns"];
  diagnostics: Diagnostic[];
}

/** Derive every change; sorted newest id first. */
export function deriveAll(repo: Repo): Snapshot {
  const changes = [...repo.changes.values()].map((f) => deriveChange(repo, f)).sort((a, b) => b.id.localeCompare(a.id));
  return {
    changes,
    triage: repo.triage,
    findings: repo.findings,
    proposals: repo.proposals,
    evalCases: repo.evalCases,
    evalRuns: repo.evalRuns,
    diagnostics: repo.diagnostics,
  };
}

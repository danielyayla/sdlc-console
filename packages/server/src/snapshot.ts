import type { ArtifactBranch } from "@sdlc/adapter-git";
import { collectSources, type CollectedSources, type MetricSourcesStatus } from "./metrics/index.js";
import {
  badges,
  computeMetrics,
  deriveAll,
  proposalViews,
  repeatSignals,
  skillStatus,
  suiteStatus,
  type ProposalView,
  type RepeatSignal,
  type SkillStatus,
  type SuiteStatus,
  gateQueues,
  validateTree,
  type StageMetrics,
  type Badges,
  type ChangeView,
  type Repo,
  type ResolvedConfig,
  type RuleDiagnostic,
} from "@sdlc/core";
import type { Bands, EvalCase, EvalRun, Finding, HookRow, ParsedAgent, ParsedClaudeMd, ParsedSkill, Proposal, Triage } from "@sdlc/schemas";
import { sessionCapacity, type Capacity } from "./sessions/capacity.js";

export interface Identity {
  id: string;
  name: string;
  roles: string[];
}

export interface SessionRecord {
  id: string;
  worktree: string;
  branch: string;
  changeId: string;
  taskId: string | null;
  mode: "AUTO" | "PLAN" | "SUPERVISED" | "HEADLESS";
  engineer: string | null;
  startedAt: string;
  heartbeatAt: string;
  status: string;
  target: string | null;
  [key: string]: unknown;
}

export interface RoleQueues {
  yours: string[];
  other: string[];
}

export interface Snapshot {
  revision: number;
  /** Unmerged `sdlc/<CHG>/<artifact>` branches overlaid on the snapshot (drafts in review). */
  branches?: ArtifactBranch[];
  ref: string | null;
  generatedAt: string;
  identity: Identity;
  defaultRole: "po" | "eng";
  changes: ChangeView[];
  queues: Record<"po" | "eng", RoleQueues>;
  badges: Record<"po" | "eng", Badges>;
  triage: { path: string; data: Triage; body: string }[];
  findings: Finding[];
  proposals: Proposal[];
  /** Proposals with what the ledger says about them: times the reason was seen, and whether the default branch already carries the line. */
  proposalViews: ProposalView[];
  /** Repeat-mistake signals (FR-43): reasons cited twice or more across sessions, with the proposal answering each. */
  repeatSignals: RepeatSignal[];
  evalCases: EvalCase[];
  evalRuns: EvalRun[];
  /** Suite banner: pass vs threshold, config-change gate, rolling budget, strip with config diffs. */
  evals: SuiteStatus;
  sessions: SessionRecord[];
  /** FR-35: active count, review backlog and the ceiling — one definition for the header, the launcher and the engine. */
  capacity: Capacity;
  config: ResolvedConfig;
  claudeMd: ParsedClaudeMd | null;
  hooks: HookRow[];
  skills: ParsedSkill[];
  /** Skills table: version, backing hook, pass % from trigger tests, findings citing (spec 5A.3). */
  skillStatus: SkillStatus[];
  agents: ParsedAgent[];
  bands: Bands | null;
  metrics: StageMetrics[];
  /** Where the metrics' external feeds come from and how fresh they are (FR-70). */
  metricSources: MetricSourcesStatus;
  validation: { blocking: boolean; diagnostics: RuleDiagnostic[] };
}

/** The full derived state the UI renders; recomputed on every refresh (P13). */
export function buildSnapshot(repo: Repo, identity: Identity, sessions: SessionRecord[], revision: number, now = new Date(), facts?: CollectedSources): Snapshot {
  const all = deriveAll(repo);
  const collected = facts ?? collectSources(repo, null);
  const ids = (q: { yours: ChangeView[]; other: ChangeView[] }): RoleQueues => ({ yours: q.yours.map((c) => c.id), other: q.other.map((c) => c.id) });
  const validation = validateTree(repo);
  return {
    revision,
    ref: repo.tree.ref,
    generatedAt: now.toISOString(),
    identity,
    defaultRole: repo.config.defaultRole,
    changes: all.changes,
    queues: { po: ids(gateQueues(all.changes, "po")), eng: ids(gateQueues(all.changes, "eng")) },
    badges: { po: badges(all.changes, repo, "po"), eng: badges(all.changes, repo, "eng") },
    triage: repo.triage,
    findings: repo.findings,
    proposals: repo.proposals,
    proposalViews: proposalViews(repo),
    repeatSignals: repeatSignals(repo),
    evalCases: repo.evalCases,
    evalRuns: repo.evalRuns,
    evals: suiteStatus(repo, now.toISOString().replace(/\.\d{3}Z$/, "Z")),
    sessions,
    capacity: sessionCapacity(sessions, (id) => all.changes.find((c) => c.id === id) ?? null, repo.config.thresholds.sessionCeiling),
    config: repo.config,
    claudeMd: repo.claudeMd,
    hooks: repo.settings?.hooks ?? [],
    skills: repo.skills,
    skillStatus: skillStatus(repo),
    agents: repo.agents,
    bands: repo.bands,
    metrics: computeMetrics(repo, all.changes, { now: now.toISOString(), sources: collected.sources }),
    metricSources: collected.status,
    validation: { blocking: validation.blocking, diagnostics: validation.diagnostics },
  };
}

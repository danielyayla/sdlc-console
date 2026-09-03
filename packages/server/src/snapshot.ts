import {
  badges,
  computeMetrics,
  deriveAll,
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
  evalCases: EvalCase[];
  evalRuns: EvalRun[];
  sessions: SessionRecord[];
  config: ResolvedConfig;
  claudeMd: ParsedClaudeMd | null;
  hooks: HookRow[];
  skills: ParsedSkill[];
  agents: ParsedAgent[];
  bands: Bands | null;
  metrics: StageMetrics[];
  validation: { blocking: boolean; diagnostics: RuleDiagnostic[] };
}

/** The full derived state the UI renders; recomputed on every refresh (P13). */
export function buildSnapshot(repo: Repo, identity: Identity, sessions: SessionRecord[], revision: number, now = new Date()): Snapshot {
  const all = deriveAll(repo);
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
    evalCases: repo.evalCases,
    evalRuns: repo.evalRuns,
    sessions,
    config: repo.config,
    claudeMd: repo.claudeMd,
    hooks: repo.settings?.hooks ?? [],
    skills: repo.skills,
    agents: repo.agents,
    bands: repo.bands,
    metrics: computeMetrics(repo, all.changes, { now: now.toISOString() }),
    validation: { blocking: validation.blocking, diagnostics: validation.diagnostics },
  };
}

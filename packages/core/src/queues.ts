import type { ChangeView } from "./derive.js";
import type { Repo } from "./repo.js";
import { STAGES, type GateRole, type StageNumber } from "./stages.js";

export interface GateQueues {
  yours: ChangeView[];
  other: ChangeView[];
}

/** The production gate (3.6) when it is open and the change has no artifact gate open. */
export function openProductionGate(c: ChangeView): ChangeView["deploy"]["productionGate"] {
  const g = c.deploy.productionGate;
  return c.valid && c.gate === null && g?.open ? g : null;
}

/** Open gates split by ownership of the active role, newest `since` first (spec §4.3). The production gate queues like the others (3.6). */
export function gateQueues(changes: readonly ChangeView[], role: GateRole | string): GateQueues {
  const open = changes.filter((c) => c.valid && (c.gate !== null || openProductionGate(c) !== null));
  const since = (c: ChangeView) => c.gate?.since ?? openProductionGate(c)?.since ?? "";
  const owned = (c: ChangeView) => (c.gate ? c.gate.ownerRole === role : (openProductionGate(c)?.ownerRoles.includes(role) ?? false));
  const bySince = (a: ChangeView, b: ChangeView) => since(b).localeCompare(since(a));
  return {
    yours: open.filter((c) => owned(c)).sort(bySince),
    other: open.filter((c) => !owned(c)).sort(bySince),
  };
}

export interface Badges {
  gates: number;
  loop: number;
  security: number;
}

/** Top-bar badges: own open gates, open triage items, findings still `new`. Hidden at 0 by the UI. */
export function badges(changes: readonly ChangeView[], repo: Pick<Repo, "triage" | "findings">, role: GateRole): Badges {
  return {
    gates: gateQueues(changes, role).yours.length,
    loop: repo.triage.filter((t) => t.data.status === "open").length,
    security: repo.findings.filter((f) => f.status === "new").length,
  };
}

export interface PipelineColumn {
  stage: StageNumber;
  name: string;
  artifact: string;
  changes: ChangeView[];
}

/** Six columns, closed changes excluded. */
export function pipeline(changes: readonly ChangeView[]): PipelineColumn[] {
  return STAGES.map((s) => ({
    stage: s.n,
    name: s.name,
    artifact: s.n === 4 ? "evals" : s.file,
    changes: changes.filter((c) => c.stage === s.n && !c.closed),
  }));
}

/** Changes where an agent is expected to produce the next artifact (work discovery, §8.2). */
export function awaitingArtifact(changes: readonly ChangeView[], stage?: StageNumber): ChangeView[] {
  return changes.filter((c) => c.valid && c.agent && !c.closed && (stage === undefined || c.stage === stage));
}

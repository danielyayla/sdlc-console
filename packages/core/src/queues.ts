import type { ChangeView } from "./derive.js";
import type { Repo } from "./repo.js";
import { STAGES, type GateRole, type StageNumber } from "./stages.js";

export interface GateQueues {
  yours: ChangeView[];
  other: ChangeView[];
}

/** Open gates split by ownership of the active role, newest `since` first (spec §4.3). */
export function gateQueues(changes: readonly ChangeView[], role: GateRole): GateQueues {
  const open = changes.filter((c) => c.valid && c.gate !== null);
  const bySince = (a: ChangeView, b: ChangeView) => (b.gate?.since ?? "").localeCompare(a.gate?.since ?? "");
  return {
    yours: open.filter((c) => c.gate?.ownerRole === role).sort(bySince),
    other: open.filter((c) => c.gate?.ownerRole !== role).sort(bySince),
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

import type { ArtifactName, GateNumber, RiskLevel } from "@sdlc/schemas";

export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6;
export type ArtifactIndex = 0 | 1 | 2 | 3 | 4 | 5;
export type GateRole = "po" | "eng" | "tech_lead";
export type GateMode = "console" | "via_pr" | "via_branch_protection";

export interface StageDef {
  n: StageNumber;
  name: string;
  artifactIndex: ArtifactIndex;
  artifact: ArtifactName;
  /** File (or directory) under the change dir that holds the artifact. */
  file: string;
  gate: GateNumber | null;
}

export const STAGES: readonly StageDef[] = [
  { n: 1, name: "Plan", artifactIndex: 0, artifact: "intent", file: "intent.md", gate: 1 },
  { n: 2, name: "Design", artifactIndex: 1, artifact: "spec", file: "spec.md", gate: 2 },
  { n: 3, name: "Build", artifactIndex: 2, artifact: "plan", file: "plan.md", gate: 3 },
  { n: 4, name: "Test", artifactIndex: 3, artifact: "evals", file: "evals", gate: null },
  { n: 5, name: "Deploy", artifactIndex: 4, artifact: "pr", file: "pr.yaml", gate: 5 },
  { n: 6, name: "Maintain", artifactIndex: 5, artifact: "incident", file: "incident.md", gate: 6 },
];

export function stageDef(n: StageNumber): StageDef {
  const def = STAGES[n - 1];
  if (!def) throw new Error(`no stage ${n}`);
  return def;
}

export interface GateDef {
  s: GateNumber;
  label: string;
  ownerRole: GateRole;
  acceptLabel: "Accept" | "Merge";
  onAccept: StageNumber;
  highRiskOverride?: { ownerRole: GateRole; mode: GateMode };
  externalMode?: GateMode;
}

/** Static gate data (blueprint §5.4, spec §1). */
export const gateDefs: Readonly<Record<GateNumber, GateDef>> = {
  1: { s: 1, label: "Accept intent.md", ownerRole: "po", acceptLabel: "Accept", onAccept: 2 },
  2: { s: 2, label: "Approve spec.md", ownerRole: "po", acceptLabel: "Accept", onAccept: 3 },
  3: {
    s: 3,
    label: "Accept plan.md",
    ownerRole: "eng",
    acceptLabel: "Accept",
    onAccept: 4,
    highRiskOverride: { ownerRole: "tech_lead", mode: "via_pr" },
  },
  5: {
    s: 5,
    label: "Merge PR",
    ownerRole: "eng",
    acceptLabel: "Merge",
    onAccept: 6,
    externalMode: "via_branch_protection",
  },
  6: { s: 6, label: "Accept incident intent", ownerRole: "po", acceptLabel: "Accept", onAccept: 1 },
};

export const ROLE_LABELS: Readonly<Record<GateRole, string>> = {
  po: "product owner",
  eng: "engineer",
  tech_lead: "tech lead",
};

export interface GateOwnership {
  role: GateRole;
  label: string;
  /** How acceptance is executed; `console` allows the in-console Accept button. */
  mode: GateMode;
}

/** Who owns a gate for a change of the given risk, and how it is accepted. */
export function gateOwner(gate: GateNumber, risk: RiskLevel, provider: "local" | "github" = "local"): GateOwnership {
  const def = gateDefs[gate];
  if (risk === "high" && def.highRiskOverride) {
    return {
      role: def.highRiskOverride.ownerRole,
      label: `${def.label} · ${ROLE_LABELS[def.highRiskOverride.ownerRole]}`,
      mode: def.highRiskOverride.mode,
    };
  }
  if (def.externalMode && provider === "github") {
    return { role: def.ownerRole, label: def.label, mode: def.externalMode };
  }
  return { role: def.ownerRole, label: def.label, mode: "console" };
}

export const STAGE_FOR_GATE: Readonly<Record<GateNumber, StageNumber>> = { 1: 1, 2: 2, 3: 3, 5: 5, 6: 6 };
export const ARTIFACT_INDEX_FOR_GATE: Readonly<Record<GateNumber, ArtifactIndex>> = { 1: 0, 2: 1, 3: 2, 5: 4, 6: 5 };

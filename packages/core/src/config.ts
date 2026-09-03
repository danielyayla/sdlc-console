import { CONFIG_DEFAULTS, type Config, type Identity, type RecordsMode } from "@sdlc/schemas";
import type { GateRole } from "./stages.js";

export interface ResolvedThresholds {
  autoFilesMax: number;
  evalPassThreshold: number;
  maxLoopRounds: number;
  sessionCeiling: number;
  suiteMinSize: number;
  noDiscriminationRuns: number;
  brokenCheckRuns: number;
}

/** Identity whose `github` login matches (case-insensitive), for attributing merges done on the code host. */
export function identityForGitHubLogin(config: ResolvedConfig, login: string): Identity | null {
  const wanted = login.toLowerCase();
  return config.identities.find((i) => i.github?.toLowerCase() === wanted) ?? null;
}

export interface ResolvedConfig {
  present: boolean;
  defaultRole: "po" | "eng";
  defaultBranch: string;
  codeHost: "local" | "github";
  identities: Identity[];
  thresholds: ResolvedThresholds;
  records: Record<"intent" | "spec" | "plan" | "evals" | "pr" | "incident", RecordsMode>;
  evals: { mode: "continuous" | "scheduled"; threshold: number; budget: number | null; schedule: string | null };
  eligibility: { coverage: "strict" | "lenient" };
  extraRoles: string[];
}

/** Apply defaults from the schema layer; never writes anything back. */
export function resolveConfig(config: Config | null): ResolvedConfig {
  const t = config?.thresholds ?? {};
  const d = CONFIG_DEFAULTS.thresholds;
  const r = config?.records ?? {};
  return {
    present: config !== null,
    defaultRole: config?.defaultRole ?? "po",
    defaultBranch: config?.defaultBranch ?? "main",
    codeHost: config?.codeHost ?? "local",
    identities: config?.identities ?? [],
    thresholds: {
      autoFilesMax: t.autoFilesMax ?? d.autoFilesMax,
      evalPassThreshold: t.evalPassThreshold ?? d.evalPassThreshold,
      maxLoopRounds: t.maxLoopRounds ?? d.maxLoopRounds,
      sessionCeiling: t.sessionCeiling ?? d.sessionCeiling,
      suiteMinSize: t.suiteMinSize ?? d.suiteMinSize,
      noDiscriminationRuns: t.noDiscriminationRuns ?? d.noDiscriminationRuns,
      brokenCheckRuns: t.brokenCheckRuns ?? d.brokenCheckRuns,
    },
    records: {
      intent: r.intent ?? "repo",
      spec: r.spec ?? "repo",
      plan: r.plan ?? "repo",
      evals: r.evals ?? "repo",
      pr: r.pr ?? "repo",
      incident: r.incident ?? "repo",
    },
    evals: {
      mode: config?.evals?.mode ?? CONFIG_DEFAULTS.evals.mode,
      threshold: config?.evals?.threshold ?? t.evalPassThreshold ?? d.evalPassThreshold,
      budget: config?.evals?.budget ?? null,
      schedule: config?.evals?.schedule ?? null,
    },
    eligibility: { coverage: config?.eligibility?.coverage ?? CONFIG_DEFAULTS.eligibility.coverage },
    extraRoles: (config?.roles ?? []).map((x) => x.name),
  };
}

/** Roles an identity holds, by git email / handle. Empty when unknown. */
export function rolesOf(config: ResolvedConfig, identityId: string): string[] {
  return config.identities.find((i) => i.id === identityId)?.roles ?? [];
}

export function holdsRole(config: ResolvedConfig, identityId: string, role: GateRole | string): boolean {
  return rolesOf(config, identityId).includes(role);
}

/** Identities holding a role; used for "no tech lead configured" style messages. */
export function identitiesWithRole(config: ResolvedConfig, role: string): Identity[] {
  return config.identities.filter((i) => i.roles.includes(role));
}

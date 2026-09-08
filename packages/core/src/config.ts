import { CONFIG_DEFAULTS, type Config, type EnvironmentKind, type Identity, type RecordsMode } from "@sdlc/schemas";
import type { GateRole } from "./stages.js";

export interface ResolvedThresholds {
  autoFilesMax: number;
  evalPassThreshold: number;
  maxLoopRounds: number;
  /** `null` = no ceiling. */
  sessionCeiling: number | null;
  suiteMinSize: number;
  noDiscriminationRuns: number;
  brokenCheckRuns: number;
  skillPassThreshold: number;
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
  /** `records.connector`: the MCP server in `.mcp.json` that owns the external records (FR-16); null when unset. */
  recordsConnector: string | null;
  /** Hosted mode (3.1): the OIDC provider `sdlc serve` signs people in with; null = local mode. */
  auth: ResolvedAuth | null;
  /** Deployment environments (3.6) in config order; empty when none are declared. */
  environments: ResolvedEnvironment[];
}

/** A deployment environment as the console runs it (3.6): declared commands only, and the production gate's roles. */
export interface ResolvedEnvironment {
  name: string;
  kind: EnvironmentKind;
  description: string | null;
  deployCommand: string;
  rollbackCommand: string;
  healthcheckCommand: string | null;
  /** Production: roles that own the production gate (`gate.roles`, default the gate 5 owner `eng`). Empty for other kinds. */
  gateRoles: string[];
}

/** The production gate's default owner: the engineer who owns gate 5 (decisions Q3). */
export const PRODUCTION_GATE_DEFAULT_ROLES: readonly string[] = ["eng"];

export interface ResolvedAuth {
  provider: "oidc";
  issuer: string;
  clientId: string;
  audience: string;
  claim: "email" | "preferred_username" | "sub";
  scopes: string[];
  publicUrl: string | null;
  sessionHours: number;
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
      sessionCeiling: t.sessionCeiling === undefined ? d.sessionCeiling : t.sessionCeiling,
      suiteMinSize: t.suiteMinSize ?? d.suiteMinSize,
      noDiscriminationRuns: t.noDiscriminationRuns ?? d.noDiscriminationRuns,
      brokenCheckRuns: t.brokenCheckRuns ?? d.brokenCheckRuns,
      skillPassThreshold: t.skillPassThreshold ?? d.skillPassThreshold,
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
    recordsConnector: config?.records?.connector ?? null,
    environments: (config?.environments ?? []).map((e) => ({
      name: e.name,
      kind: e.kind,
      description: e.description ?? null,
      deployCommand: e.deploy.command,
      rollbackCommand: e.rollback.command,
      healthcheckCommand: e.healthcheck?.command ?? null,
      gateRoles: e.kind === "production" ? (e.gate?.roles ?? [...PRODUCTION_GATE_DEFAULT_ROLES]) : [],
    })),
    auth: config?.auth
      ? {
          provider: "oidc",
          issuer: config.auth.issuer.replace(/\/$/, ""),
          clientId: config.auth.clientId,
          audience: config.auth.audience ?? config.auth.clientId,
          claim: config.auth.claim ?? "email",
          scopes: config.auth.scopes ?? ["openid", "email", "profile"],
          publicUrl: config.auth.publicUrl?.replace(/\/$/, "") ?? null,
          sessionHours: config.auth.sessionHours ?? 12,
        }
      : null,
  };
}

/** The identity a signed-in person acts as: a declared `subject` wins, else the configured claim must equal `id` (emails compare case-insensitively). Null = not on the list. */
export function identityForClaims(config: ResolvedConfig, claims: { sub: string; email?: string; preferred_username?: string }): Identity | null {
  const bySubject = config.identities.find((i) => i.subject !== undefined && i.subject === claims.sub);
  if (bySubject) return bySubject;
  const claim = config.auth?.claim ?? "email";
  const value = claims[claim];
  if (typeof value !== "string" || value === "") return null;
  const fold = (s: string) => (claim === "email" ? s.toLowerCase() : s);
  return config.identities.find((i) => fold(i.id) === fold(value)) ?? null;
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

/** An environment by name; null when `sdlc/config.yaml` does not declare it. */
export function environmentByName(config: ResolvedConfig, name: string): ResolvedEnvironment | null {
  return config.environments.find((e) => e.name === name) ?? null;
}

/** Environments an agent may deploy to (3.6): every kind but production. */
export function agentDeployableEnvironments(config: ResolvedConfig): ResolvedEnvironment[] {
  return config.environments.filter((e) => e.kind !== "production");
}

/** The environment behind the production gate: the first `production` entry; null when none is declared. */
export function productionEnvironment(config: ResolvedConfig): ResolvedEnvironment | null {
  return config.environments.find((e) => e.kind === "production") ?? null;
}

/** Whether an identity holds one of the roles that own the production gate. */
export function holdsProductionGate(config: ResolvedConfig, identityId: string, env: ResolvedEnvironment): boolean {
  return env.gateRoles.some((r) => holdsRole(config, identityId, r));
}

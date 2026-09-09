import type { Deploy, Deployment, DeploymentStatus, EnvironmentKind, RollbackRehearsal } from "@sdlc/schemas";
import { productionEnvironment, type ResolvedConfig, type ResolvedEnvironment } from "./config.js";
import type { ChangeFiles } from "./repo.js";
import { ROLE_LABELS, type GateRole } from "./stages.js";

/** The check the production gate requires (3.6): published as a check run under the App, a commit status under a token. */
export const ROLLBACK_CHECK_NAME = "rollback-rehearsed";
export const ROLLBACK_CHECK = `sdlc/${ROLLBACK_CHECK_NAME}`;

/** Deploy and rehearsal output is kept verbatim up to this many characters; beyond it the head is kept with a note saying how much is missing. */
export const DEPLOY_OUTPUT_LIMIT = 200_000;

/** Never a summary: the head of the output verbatim plus a line saying how much was cut. */
export function clipOutput(text: string, limit = DEPLOY_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const note = `\n… ${text.length - limit} more characters not recorded (output clipped at ${limit} characters)`;
  return `${text.slice(0, limit)}${note}`;
}

export interface EnvironmentView {
  name: string;
  kind: EnvironmentKind;
  /** Declared in `sdlc/config.yaml` (a record may name an environment the config no longer lists). */
  configured: boolean;
  /** An agent's `deploy_<env>` tool exists for it: every kind but production. */
  agentDeployable: boolean;
  status: DeploymentStatus | "not-deployed";
  latest: Deployment | null;
  deployments: Deployment[];
  rehearsals: RollbackRehearsal[];
  /** Production: the roles that own its gate. */
  gateRoles: string[];
}

export interface ProductionGateCheck {
  name: string;
  verdict: "pass" | "fail" | "pending";
  /** One line, literal. */
  summary: string;
  /** The rehearsal output behind the verdict, verbatim; null when there is none. */
  evidence: string | null;
  /** The rehearsal the verdict rests on. */
  rehearsal: RollbackRehearsal | null;
}

export interface ProductionGateView {
  env: string;
  ownerRoles: string[];
  ownerLabel: string;
  /** Open: the PR merged, production is declared, and the merged commit is not deployed there yet (or its deploy failed). */
  open: boolean;
  /** The commit the gate is about — the merge commit; null before the merge. */
  sha: string | null;
  /** When the gate opened (the merge time). */
  since: string | null;
  checks: ProductionGateCheck[];
  /** Why the gate cannot be accepted right now; null when every check passes. */
  blocked: string | null;
  authorized: { by: string; at: string } | null;
  /** The production deployment of `sha`: running, succeeded or failed; null before one starts. */
  deployment: Deployment | null;
}

export interface DeployView {
  record: Deploy | null;
  environments: EnvironmentView[];
  rehearsals: RollbackRehearsal[];
  productionGate: ProductionGateView | null;
}

function kindOf(config: ResolvedConfig, name: string, declared?: EnvironmentKind): EnvironmentKind {
  return declared ?? config.environments.find((e) => e.name === name)?.kind ?? "preview";
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as GateRole] ?? role.replace(/_/g, " ");
}

/**
 * The production gate's required check (3.6): green only when a rollback was
 * rehearsed with success in a non-production environment at the commit going
 * to production — the merge commit, or the merged PR's tested head (the same
 * change before the merge commit wrapped it).
 */
export function rollbackRehearsedCheck(config: ResolvedConfig, record: Deploy | null, sha: string | null, headSha: string | null): ProductionGateCheck {
  const rehearsals = (record?.rehearsals ?? []).filter((r) => kindOf(config, r.env, r.kind) !== "production");
  const accepted = new Set([sha, headSha].filter((s): s is string => s !== null));
  const short = (s: string) => s.slice(0, 7);
  const wanted = sha ? `${short(sha)}${headSha && headSha !== sha ? ` (or the merged head ${short(headSha)})` : ""}` : "the merged commit";
  // the latest rehearsal at the commit decides: a rollback that stopped working after an earlier success is not rehearsed
  const atSha = [...rehearsals].reverse().find((r) => accepted.has(r.sha)) ?? null;
  if (atSha?.status === "succeeded") {
    return { name: ROLLBACK_CHECK, verdict: "pass", summary: `rollback rehearsed on ${atSha.env} at ${short(atSha.sha)} by ${atSha.actor.id} (${atSha.rehearsedAt}) — exit ${atSha.exitCode}`, evidence: atSha.output, rehearsal: atSha };
  }
  if (atSha) {
    return { name: ROLLBACK_CHECK, verdict: "fail", summary: `latest rollback rehearsal on ${atSha.env} at ${short(atSha.sha)} failed (exit ${atSha.exitCode}) — the production gate needs a succeeded rehearsal at ${wanted}`, evidence: atSha.output, rehearsal: atSha };
  }
  const latest = rehearsals.at(-1) ?? null;
  if (latest) {
    return { name: ROLLBACK_CHECK, verdict: "fail", summary: `latest rollback rehearsal on ${latest.env} ${latest.status} at ${short(latest.sha)}, not ${wanted} — the production gate needs a succeeded rehearsal at ${wanted}`, evidence: latest.output, rehearsal: latest };
  }
  const where = config.environments.filter((e) => e.kind !== "production").map((e) => e.name);
  return { name: ROLLBACK_CHECK, verdict: "pending", summary: `no rollback rehearsal recorded at ${wanted}${where.length > 0 ? ` — rehearse on ${where.join(" or ")} first` : " — declare a non-production environment to rehearse on"}`, evidence: null, rehearsal: null };
}

function statusOf(record: Deploy | null, name: string, entries: Deployment[]): DeploymentStatus | "not-deployed" {
  const latest = entries.at(-1);
  if (latest) return latest.status;
  // a record from before 3.6 carries the headline alone
  if (record && !record.environments && record.env === name) return record.status === "started" ? "running" : record.status;
  return "not-deployed";
}

/** Everything the console shows about a change's deployments, and the production gate (3.6). Pure over the files and the config. */
export function deriveDeploy(config: ResolvedConfig, files: ChangeFiles, prMerged: boolean): DeployView {
  const record = files.deploy;
  const entries = record?.environments ?? [];
  const rehearsals = record?.rehearsals ?? [];
  const names = [...config.environments.map((e) => e.name)];
  for (const e of entries) if (!names.includes(e.env)) names.push(e.env);
  for (const r of rehearsals) if (!names.includes(r.env)) names.push(r.env);
  if (record && !record.environments && !names.includes(record.env)) names.push(record.env);
  const environments: EnvironmentView[] = names.map((name) => {
    const declared: ResolvedEnvironment | null = config.environments.find((e) => e.name === name) ?? null;
    const deployments = entries.filter((e) => e.env === name);
    const kind = declared?.kind ?? deployments.at(-1)?.kind ?? rehearsals.find((r) => r.env === name)?.kind ?? "preview";
    return {
      name,
      kind,
      configured: declared !== null,
      agentDeployable: declared !== null && declared.kind !== "production",
      status: statusOf(record, name, deployments),
      latest: deployments.at(-1) ?? null,
      deployments,
      rehearsals: rehearsals.filter((r) => r.env === name),
      gateRoles: declared?.gateRoles ?? [],
    };
  });

  const production = productionEnvironment(config);
  let productionGate: ProductionGateView | null = null;
  if (production) {
    const sha = files.pr?.mergeSha ?? null;
    const headSha = files.pr?.headSha ?? null;
    const deployments = entries.filter((e) => e.env === production.name && (sha === null || e.sha === sha));
    const deployment = deployments.at(-1) ?? null;
    const legacyDeployed = record !== null && !record.environments && record.env === production.name && record.status === "succeeded";
    const settled = deployment !== null && (deployment.status === "succeeded" || deployment.status === "running" || deployment.status === "rolled_back");
    const open = prMerged && sha !== null && !settled && !legacyDeployed;
    const check = rollbackRehearsedCheck(config, record, sha, headSha);
    const authorized = deployment?.authorizedBy && deployment.authorizedAt ? { by: deployment.authorizedBy, at: deployment.authorizedAt } : record && !record.environments && record.authorizedBy && record.authorizedAt ? { by: record.authorizedBy, at: record.authorizedAt } : null;
    productionGate = {
      env: production.name,
      ownerRoles: production.gateRoles,
      ownerLabel: production.gateRoles.map(roleLabel).join(" or "),
      open,
      sha,
      since: prMerged ? (files.pr?.mergedAt ?? null) : null,
      checks: [check],
      blocked: check.verdict === "pass" ? null : `${ROLLBACK_CHECK} is ${check.verdict}: ${check.summary}`,
      authorized,
      deployment,
    };
  }
  return { record, environments, rehearsals, productionGate };
}

/** Status line for stage 6 with a production environment declared (3.6). */
export function productionStatus(gate: ProductionGateView): string | null {
  const d = gate.deployment;
  if (d?.status === "running") return `Deploying to ${gate.env} · ${d.sha.slice(0, 7)}`;
  if (d?.status === "succeeded" || (!gate.open && gate.sha !== null && d === null)) return "Deployed · monitoring";
  if (d?.status === "failed" && !gate.open) return `${gate.env} deploy failed`;
  if (gate.open) {
    if (d?.status === "failed") return `${gate.env} deploy failed (exit ${d.exitCode ?? "?"}) — production gate open again for the ${gate.ownerLabel}`;
    if (gate.blocked) return `Merged · production gate needs a rollback rehearsal`;
    return `Merged · production gate — waiting on the ${gate.ownerLabel}`;
  }
  return null;
}

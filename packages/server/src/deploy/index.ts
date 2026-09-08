import { execFile } from "node:child_process";
import { commitWritePlan, newUlid, readTree, type PrCheck } from "@sdlc/adapter-git";
import { hostedCodeHostFrom } from "../engine/codehost.js";
import { ROLLBACK_CHECK_NAME, deriveChange, environmentByName, finishDeployment, loadRepo, recordRehearsal, recordSessionDeploys, rollbackRehearsedCheck, startDeployment, validateWritePlan, type ChangeView, type Repo, type ResolvedEnvironment, type SessionDeployItem } from "@sdlc/core";
import { DEFAULT_AGENT_ID, readSessionDeploys } from "@sdlc/mcp";
import type { Deployment, RollbackRehearsal } from "@sdlc/schemas";
import type { ActionResult } from "../actions.js";
import { SYSTEM_IDENTITY } from "../engine/codehost.js";
import type { StoredSession } from "../sessions/registry.js";
import { ActionError, type StateStore } from "../store.js";

/** Runs one declared command in the home with the deploy variables set; the output comes back verbatim. */
export interface DeployExec {
  (cmd: string, cwd: string, env: Record<string, string | undefined>): Promise<{ exitCode: number; output: string }>;
}

const DEPLOY_TIMEOUT_MS = 30 * 60_000;

export function shellDeploy(cmd: string, cwd: string, env: Record<string, string | undefined>): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: DEPLOY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode: code, output: `${stdout}${stderr ? `\n${stderr}` : ""}` });
    });
  });
}

export interface DeployDeps {
  exec?: DeployExec;
  /** Environment for the code host (`GITHUB_TOKEN` / the App) and the commands. */
  env?: Record<string, string | undefined>;
  now?: () => Date;
  log?: (line: string) => void;
}

function viewOf(repo: Repo, id: string): ChangeView {
  const files = repo.changes.get(id);
  if (!files) throw new ActionError(404, `${id} not found`);
  return deriveChange(repo, files);
}

function envOf(repo: Repo, name: string): ResolvedEnvironment {
  const env = environmentByName(repo.config, name);
  if (!env) throw new ActionError(404, `${name} is not an environment in sdlc/config.yaml (${repo.config.environments.map((e) => e.name).join(", ") || "none declared"})`);
  return env;
}

function vars(deps: DeployDeps, view: ChangeView, env: ResolvedEnvironment, sha: string): Record<string, string | undefined> {
  return { ...(deps.env ?? process.env), SDLC_CHANGE: view.id, SDLC_ENV: env.name, SDLC_ENV_KIND: env.kind, SDLC_SHA: sha };
}

/**
 * The commit a person's deploy is about: the merged commit once the PR
 * merged, else the PR's tested head. A change without a PR has nothing to
 * deploy — the console deploys changes, not checkouts.
 */
export function shaToDeploy(view: ChangeView, env: ResolvedEnvironment): string {
  if (env.kind === "production") {
    const gate = view.deploy.productionGate;
    if (!gate?.sha) throw new ActionError(409, `${view.id} is not merged yet (stage ${view.stage}: ${view.status}); the production gate opens on the merge`);
    return gate.sha;
  }
  const sha = view.pr?.mergeSha ?? view.pr?.headSha;
  if (!sha) throw new ActionError(409, `${view.id} has no pull request yet (stage ${view.stage}: ${view.status}); nothing to deploy to ${env.name}`);
  return sha;
}

/**
 * Deploy a change to an environment as the acting person (3.6). The record
 * goes first — `deploy.started` and a `running` entry, and for production
 * the gate decision `deploy.authorized` in the same commit, refused unless
 * the person holds the gate role and the rollback is rehearsed — then the
 * declared command runs, then the outcome is committed with its output
 * verbatim. The command never runs before the first commit exists.
 */
export async function deployEnvironment(store: StateStore, id: string, envName: string, deps: DeployDeps = {}): Promise<ActionResult & { deployment: Deployment }> {
  await store.refresh();
  const repo0 = store.currentRepo;
  if (!repo0) throw new ActionError(502, "repository not loaded", [], true);
  const before = viewOf(repo0, id);
  const env = envOf(repo0, envName);
  const sha = shaToDeploy(before, env);
  const actor = { type: "human" as const, id: store.who.id };
  const started = await store.act((repo, ctx) => startDeployment(repo, viewOf(repo, id), { env: env.name, sha, actor }, ctx));
  const exec = deps.exec ?? shellDeploy;
  const r = await exec(env.deployCommand, store.root, vars(deps, before, env, sha));
  const healthcheck = r.exitCode === 0 && env.healthcheckCommand ? { command: env.healthcheckCommand, ...(await exec(env.healthcheckCommand, store.root, vars(deps, before, env, sha))) } : undefined;
  const finished = await store.act((repo, ctx) => finishDeployment(repo, viewOf(repo, id), { env: env.name, sha, exitCode: r.exitCode, output: r.output, ...(healthcheck ? { healthcheck } : {}) }, ctx));
  const after = finished.snapshot.changes.find((c) => c.id === id);
  const deployment = after?.deploy.environments.find((e) => e.name === env.name)?.latest;
  if (!deployment) throw new ActionError(502, `${id}: deployment of ${sha.slice(0, 7)} to ${env.name} not found after the commit`, [], true);
  void started;
  const toast = deployment.status === "succeeded" ? `${id} deployed to ${env.name} · ${sha.slice(0, 7)}${env.kind === "production" ? " · production gate accepted" : ""}` : `${id}: deploy to ${env.name} failed (exit ${deployment.exitCode ?? "?"}) — output recorded`;
  return { commit: finished.commit, snapshot: finished.snapshot, toast, changeId: id, deployment };
}

/**
 * Rehearse the rollback on a non-production environment as the acting person
 * (3.6): the declared rollback command runs against the commit the environment
 * has, the outcome is committed verbatim as a rehearsal, and in GitHub mode
 * `sdlc/rollback-rehearsed` is published on the commit the production gate
 * is about.
 */
export async function rehearseRollback(store: StateStore, id: string, envName: string, deps: DeployDeps = {}): Promise<ActionResult & { rehearsal: RollbackRehearsal; published: string[] }> {
  await store.refresh();
  const repo0 = store.currentRepo;
  if (!repo0) throw new ActionError(502, "repository not loaded", [], true);
  const before = viewOf(repo0, id);
  const env = envOf(repo0, envName);
  if (env.kind === "production") throw new ActionError(409, `a rollback is rehearsed against a non-production environment, never ${env.name}`);
  const deployed = before.deploy.environments.find((e) => e.name === env.name)?.deployments.filter((d) => d.status === "succeeded").at(-1) ?? null;
  if (!deployed) throw new ActionError(409, `nothing is deployed to ${env.name} for ${id}; deploy there first, then rehearse the rollback`);
  const exec = deps.exec ?? shellDeploy;
  const rehearsedAt = (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await exec(env.rollbackCommand, store.root, vars(deps, before, env, deployed.sha));
  const actor = { type: "human" as const, id: store.who.id };
  const done = await store.act((repo, ctx) => recordRehearsal(repo, viewOf(repo, id), { env: env.name, sha: deployed.sha, exitCode: r.exitCode, output: r.output, rehearsedAt, actor }, ctx));
  const after = done.snapshot.changes.find((c) => c.id === id);
  const rehearsal = after?.deploy.rehearsals.at(-1);
  if (!after || !rehearsal) throw new ActionError(502, `${id}: rehearsal on ${env.name} not found after the commit`, [], true);
  const published = await publishRollbackCheck(store.root, repo0, after, deps);
  const toast = rehearsal.status === "succeeded" ? `${id}: rollback rehearsed on ${env.name} at ${deployed.sha.slice(0, 7)} — the production gate's check is green` : `${id}: rollback rehearsal on ${env.name} failed (exit ${rehearsal.exitCode}) — output recorded`;
  return { commit: done.commit, snapshot: done.snapshot, toast, changeId: id, rehearsal, published };
}

/** The `sdlc/rollback-rehearsed` check for a change at a commit, from the committed records. */
export function rollbackCheckFor(view: ChangeView, repo: Repo): PrCheck {
  const c = rollbackRehearsedCheck(repo.config, view.deploy.record, view.pr?.mergeSha ?? null, view.pr?.headSha ?? null);
  return { name: ROLLBACK_CHECK_NAME, verdict: c.verdict, summary: c.summary, ...(c.evidence !== null ? { evidence: c.evidence } : {}) };
}

/**
 * GitHub mode: publish `sdlc/rollback-rehearsed` on the commits the gate is
 * about — the merged commit and the PR's tested head — a status under a
 * token, a check run with the rehearsal output under the App. Local mode
 * publishes nothing; a failure to publish is logged and never blocks the
 * record (the committed deploy.yaml is the truth the gate reads).
 */
export async function publishRollbackCheck(root: string, repo: Repo, view: ChangeView, deps: DeployDeps = {}): Promise<string[]> {
  if (repo.config.codeHost === "local") return [];
  const host = hostedCodeHostFrom(repo.config.codeHost, deps.env ?? process.env);
  if (!host) {
    deps.log?.(`${view.id}: config.codeHost is ${repo.config.codeHost} but no token or App is set; ${ROLLBACK_CHECK_NAME} not published`);
    return [];
  }
  const check = rollbackCheckFor(view, repo);
  const shas = [...new Set([view.pr?.mergeSha, view.pr?.headSha].filter((s): s is string => typeof s === "string"))];
  const published: string[] = [];
  for (const sha of shas) {
    try {
      await host.publishCheck(root, sha, check, view.pr?.url);
      published.push(sha);
    } catch (e) {
      deps.log?.(`${view.id}: ${ROLLBACK_CHECK_NAME} on ${sha.slice(0, 7)} not published: ${(e as Error).message}`);
    }
  }
  return published;
}

export interface SessionDeployOutcome {
  commit: string | null;
  items: number;
  rehearsed: boolean;
  published: string[];
  note: string;
}

/**
 * What a session did through `deploy_<env>` and `rehearse_rollback` becomes
 * the change's record when the session ends (3.6): one sdlc-bot commit on the
 * default branch with the agent as the recorded actor and the job's trailer,
 * then the gate's check published in GitHub mode. Production is never among
 * them — the tools do not exist for it and core refuses to record it.
 */
export async function recordDeploysForSession(input: { root: string; session: StoredSession; jobKey: string; env?: Record<string, string | undefined>; now?: () => Date; log?: (line: string) => void }, repo: Repo): Promise<SessionDeployOutcome> {
  const { session } = input;
  const drafts = readSessionDeploys(session.worktreePath, session.id);
  if (drafts.length === 0) return { commit: null, items: 0, rehearsed: false, published: [], note: `${session.id} deployed nothing` };
  const files = repo.changes.get(session.changeId);
  if (!files) throw new Error(`${session.changeId} not found`);
  const view = deriveChange(repo, files);
  const items: SessionDeployItem[] = drafts.map((d) => (d.kind === "deploy" ? { kind: "deploy", env: d.env, sha: d.sha, ...(d.version ? { version: d.version } : {}), startedAt: d.startedAt, finishedAt: d.finishedAt, exitCode: d.exitCode, output: d.output, ...(d.healthcheck ? { healthcheck: d.healthcheck } : {}) } : { kind: "rehearsal", env: d.env, sha: d.sha, rehearsedAt: d.rehearsedAt, finishedAt: d.finishedAt, exitCode: d.exitCode, output: d.output }));
  const agent = input.env?.["SDLC_AGENT_ID"] ?? DEFAULT_AGENT_ID;
  const now = (input.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = recordSessionDeploys(repo, view, items, { type: "agent", id: agent, session: session.id }, { now, newId: newUlid, actor: { id: SYSTEM_IDENTITY.id, name: SYSTEM_IDENTITY.name } });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => `${d.rule}: ${d.message}`).join("; "));
  const report = validateWritePlan(repo, r.plan);
  if (report.blocking) throw new Error(`deploy record rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
  const plan = { ...r.plan, trailers: { ...r.plan.trailers, "SDLC-Job": input.jobKey } };
  const commit = await commitWritePlan(input.root, plan, { identity: SYSTEM_IDENTITY });
  const rehearsed = items.some((i) => i.kind === "rehearsal");
  let published: string[] = [];
  if (rehearsed) {
    const repo2 = loadRepo(await readTree(input.root, "HEAD"));
    const files2 = repo2.changes.get(session.changeId);
    if (files2) published = await publishRollbackCheck(input.root, repo2, deriveChange(repo2, files2), { ...(input.env ? { env: input.env } : {}), ...(input.log ? { log: input.log } : {}) });
  }
  return { commit, items: items.length, rehearsed, published, note: `${session.id}: ${r.plan.commitMessage.replace(/^sdlc\([^)]*\): /, "")}${published.length > 0 ? ` · ${ROLLBACK_CHECK_NAME} published on ${published.map((s) => s.slice(0, 7)).join(", ")}` : ""}` };
}

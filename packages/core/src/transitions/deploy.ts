import { stringifyYaml, type Deploy, type Deployment, type Event, type RollbackRehearsal } from "@sdlc/schemas";
import { environmentByName, holdsProductionGate, rolesOf, type ResolvedEnvironment } from "../config.js";
import { clipOutput } from "../deploy.js";
import type { ChangeView } from "../derive.js";
import type { ChangeFiles, Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, SYSTEM_ACTOR, type TransitionContext } from "./context.js";

/** Who ran the command: a person (through console or CLI), an agent session (`deploy_<env>`), or the system. */
export interface DeployActorInput {
  type: "human" | "agent" | "system";
  id: string;
  session?: string;
}

export interface StartDeploymentInput {
  env: string;
  /** The commit being deployed. Production: must be the merged commit the gate is about. */
  sha: string;
  version?: string;
  actor: DeployActorInput;
  /** Production gate note, kept on `deploy.authorized`. */
  note?: string;
}

export interface FinishDeploymentInput {
  env: string;
  sha: string;
  exitCode: number;
  /** Command output, verbatim (clipped with a note when huge). */
  output: string;
  finishedAt?: string;
  healthcheck?: { command: string; exitCode: number; output: string };
}

export interface RecordDeploymentInput extends FinishDeploymentInput {
  version?: string;
  startedAt: string;
  actor: DeployActorInput;
}

export interface RecordRehearsalInput {
  env: string;
  /** The commit the environment had deployed when the rollback was rehearsed. */
  sha: string;
  exitCode: number;
  output: string;
  rehearsedAt: string;
  finishedAt?: string;
  actor: DeployActorInput;
}

/** One item a session recorded through `deploy_<env>` / `rehearse_rollback`, in the order it happened. */
export type SessionDeployItem = ({ kind: "deploy" } & Omit<RecordDeploymentInput, "actor">) | ({ kind: "rehearsal" } & Omit<RecordRehearsalInput, "actor">);

const short = (sha: string) => sha.slice(0, 7);

function versionOf(input: { version?: string; sha: string }): string {
  return input.version && input.version.trim() !== "" ? input.version : short(input.sha);
}

/** The record with one more deployment; the headline follows the latest entry. */
export function appendDeployment(record: Deploy | null, entry: Deployment): Deploy {
  const environments = [...(record?.environments ?? []), entry];
  return {
    schema: 1,
    env: entry.env,
    version: entry.version ?? short(entry.sha),
    at: entry.finishedAt ?? entry.startedAt,
    status: entry.status,
    ...(entry.authorizedBy !== undefined ? { authorizedBy: entry.authorizedBy } : {}),
    ...(entry.authorizedAt !== undefined ? { authorizedAt: entry.authorizedAt } : {}),
    ...(record?.rehearsals ? { rehearsals: record.rehearsals } : {}),
    environments,
  };
}

/** The record with the deployment at `index` replaced; the headline follows it when it is the latest entry. */
export function replaceDeployment(record: Deploy, index: number, entry: Deployment): Deploy {
  const environments = (record.environments ?? []).map((e, i) => (i === index ? entry : e));
  const latest = environments.at(-1) ?? entry;
  const { authorizedBy: _b, authorizedAt: _a, ...rest } = record;
  void _b;
  void _a;
  return {
    ...rest,
    env: latest.env,
    version: latest.version ?? short(latest.sha),
    at: latest.finishedAt ?? latest.startedAt,
    status: latest.status,
    ...(latest.authorizedBy !== undefined ? { authorizedBy: latest.authorizedBy } : {}),
    ...(latest.authorizedAt !== undefined ? { authorizedAt: latest.authorizedAt } : {}),
    environments,
  };
}

export function appendRehearsal(record: Deploy, entry: RollbackRehearsal): Deploy {
  return { ...record, rehearsals: [...(record.rehearsals ?? []), entry] };
}

function eventFor(ev: EventBuilder, ctx: TransitionContext, repo: Repo, actor: DeployActorInput, cycle: number, name: Event["event"], data: Record<string, unknown>, role?: string | null): Event {
  if (actor.type === "agent") return ev.agent(name as never, cycle, data as never, { id: actor.id, session: actor.session ?? "mcp" });
  if (actor.type === "system") return ev.system(name as never, cycle, data as never);
  return ev.human(name as never, role ?? rolesOf(repo.config, actor.id)[0] ?? null, cycle, data as never);
}

/**
 * The role a finished deployment is recorded under is the one its start was
 * recorded under: for production that is the gate role the person holds (the
 * `deploy.authorized` role), never the person's first configured role or
 * whatever the role switcher shows when the command ends.
 */
function finishingRole(repo: Repo, running: Deployment, actor: DeployActorInput): string | null {
  if (actor.type !== "human") return null;
  const held = rolesOf(repo.config, actor.id);
  if (running.kind === "production") {
    const env = environmentByName(repo.config, running.env);
    const gateRole = env?.gateRoles.find((r) => held.includes(r));
    if (gateRole) return gateRole;
  }
  return held[0] ?? null;
}

function trailers(events: readonly Event[], actor: DeployActorInput): Record<string, string> {
  const first = events[0];
  return { ...(first ? { "SDLC-Event": first.id } : {}), "SDLC-Actor": `${actor.type}:${actor.id}`, ...(actor.session ? { "SDLC-Session": actor.session } : {}) };
}

function planActor(actor: DeployActorInput, role: string | null): WritePlan["actor"] {
  if (actor.type === "agent") return { type: "agent", id: actor.id, session: actor.session ?? "mcp" };
  if (actor.type === "system") return SYSTEM_ACTOR;
  return role ? { type: "human", id: actor.id, role } : { type: "human", id: actor.id };
}

type Refusal = Extract<TransitionResult, { ok: false }>;

const refusal = (rule: string, message: string, path: string): Refusal => refuse(rule, message, path) as Refusal;

function loaded(repo: Repo, view: ChangeView): { files: ChangeFiles; cycle: number } | Refusal {
  const files = repo.changes.get(view.id);
  if (!files?.change) return refusal("change.missing", `${view.id} not loaded`, `sdlc/changes/${view.id}`);
  if (!view.valid) return refusal("change.invalid", `${view.id} has validation errors; fix them before deploying`, files.dir);
  if (view.closed) return refusal("change.closed", `${view.id} is closed`, files.dir);
  return { files, cycle: files.change.cycle };
}

function environment(repo: Repo, name: string, path: string): ResolvedEnvironment | Refusal {
  const env = environmentByName(repo.config, name);
  if (!env) return refusal("deploy.env-unknown", `${name} is not an environment in sdlc/config.yaml (${repo.config.environments.map((e) => e.name).join(", ") || "none declared"})`, path);
  return env;
}

const isRefusal = (x: object): x is Refusal => "ok" in x && (x as { ok: unknown }).ok === false;

/**
 * Begin a deployment (3.6): the entry goes into deploy.yaml as `running` and
 * `deploy.started` onto the ledger before the command runs, so a crash
 * mid-deploy leaves a record. Production is the gate: only a person holding
 * the gate's role, only the merged commit, only with the rollback rehearsed —
 * the decision is `deploy.authorized` in the same commit, and the command
 * never runs before that commit exists. There is no agent or system path
 * into production and no force flag.
 */
export function startDeployment(repo: Repo, view: ChangeView, input: StartDeploymentInput, ctx: TransitionContext): TransitionResult {
  const l = loaded(repo, view);
  if (isRefusal(l)) return l;
  const { files, cycle } = l;
  const path = `${files.dir}/deploy.yaml`;
  const env = environment(repo, input.env, path);
  if (isRefusal(env)) return env;
  const inFlight = (files.deploy?.environments ?? []).find((e) => e.env === env.name && e.status === "running");
  if (inFlight) return refuse("deploy.in-flight", `${env.name} is already deploying ${short(inFlight.sha)} (started ${inFlight.startedAt}); one deployment per environment at a time`, path);
  const ev = new EventBuilder(ctx, files, view.id);
  const events: Event[] = [];
  let role: string | null;
  let entry: Deployment;
  if (env.kind === "production") {
    if (input.actor.type !== "human" || input.actor.id !== ctx.actor.id) return refuse("production.actor-not-human", `${env.name} is behind the production gate: a person holding ${env.gateRoles.join(" or ")} deploys it through the console or \`sdlc deploy ${env.name}\`; no agent or system path exists`, path);
    const gate = view.deploy.productionGate;
    if (!gate || gate.env !== env.name) return refuse("production.gate-missing", `${env.name} has no production gate on ${view.id}`, path);
    if (!gate.open) return refuse("production.gate-closed", gate.deployment?.status === "running" ? `${env.name} is deploying ${short(gate.deployment.sha)} already` : gate.sha === null ? `${view.id} is not merged yet (stage ${view.stage}: ${view.status}); the production gate opens on the merge` : `${short(gate.sha)} is already deployed to ${env.name}`, path);
    if (input.sha !== gate.sha) return refuse("production.sha-mismatch", `the production gate is about the merged commit ${short(gate.sha ?? "")}, not ${short(input.sha)}`, path);
    if (!holdsProductionGate(repo.config, ctx.actor.id, env)) return refuse("production.not-owner", `${ctx.actor.id} does not hold ${env.gateRoles.map((r) => `the ${r} role`).join(" or ")} that owns the production gate`, path);
    if (gate.blocked) return refuse("production.rollback-not-rehearsed", gate.blocked, path);
    role = env.gateRoles.find((r) => rolesOf(repo.config, ctx.actor.id).includes(r)) ?? null;
    const version = versionOf(input);
    events.push(ev.human("deploy.authorized", role, cycle, { env: env.name, version, sha: input.sha, ...(input.note ? { note: input.note } : {}) }));
    events.push(ev.human("deploy.started", role, cycle, { env: env.name, version, sha: input.sha }));
    entry = { env: env.name, kind: env.kind, status: "running", sha: input.sha, version, command: env.deployCommand, startedAt: ctx.now, output: "", actor: { type: "human", id: ctx.actor.id }, authorizedBy: ctx.actor.id, authorizedAt: ctx.now };
  } else {
    const version = versionOf(input);
    events.push(eventFor(ev, ctx, repo, input.actor, cycle, "deploy.started", { env: env.name, version, sha: input.sha }));
    role = input.actor.type === "human" ? (rolesOf(repo.config, input.actor.id)[0] ?? null) : null;
    entry = { env: env.name, kind: env.kind, status: "running", sha: input.sha, version, command: env.deployCommand, startedAt: ctx.now, output: "", actor: { type: input.actor.type, id: input.actor.id, ...(input.actor.session ? { session: input.actor.session } : {}) } };
  }
  const record = appendDeployment(files.deploy, entry);
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path, content: stringifyYaml(record) }],
    events: events.map((e) => ev.write(e)),
    commitMessage: env.kind === "production" ? `sdlc(${view.id}): production gate accepted → deploy ${env.name} ← ${short(input.sha)}` : `sdlc(${view.id}): deploy ${env.name} ← ${short(input.sha)}`,
    trailers: trailers(events, input.actor),
    actor: planActor(input.actor, role),
  };
  return { ok: true, plan };
}

/** The command finished: the running entry becomes `succeeded` or `failed` with its output verbatim, and the ledger says which. */
export function finishDeployment(repo: Repo, view: ChangeView, input: FinishDeploymentInput, ctx: TransitionContext): TransitionResult {
  const l = loaded(repo, view);
  if (isRefusal(l)) return l;
  const { files, cycle } = l;
  const path = `${files.dir}/deploy.yaml`;
  const record = files.deploy;
  const entries = record?.environments ?? [];
  let index = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.env === input.env && e.sha === input.sha && e.status === "running") {
      index = i;
      break;
    }
  }
  const running = entries[index];
  if (!record || !running) return refuse("deploy.not-running", `no deployment of ${short(input.sha)} to ${input.env} is running on ${view.id}`, path);
  const healthy = !input.healthcheck || input.healthcheck.exitCode === 0;
  const status: Deployment["status"] = input.exitCode === 0 && healthy ? "succeeded" : "failed";
  const finishedAt = input.finishedAt ?? ctx.now;
  const entry: Deployment = { ...running, status, finishedAt, exitCode: input.exitCode, output: clipOutput(input.output), ...(input.healthcheck ? { healthcheck: { ...input.healthcheck, output: clipOutput(input.healthcheck.output) } } : {}) };
  const ev = new EventBuilder(ctx, files, view.id);
  const actor: DeployActorInput = { type: running.actor.type, id: running.actor.id, ...(running.actor.session ? { session: running.actor.session } : {}) };
  const version = running.version ?? short(running.sha);
  const reason = status === "failed" ? (input.exitCode !== 0 ? `${running.command} exited ${input.exitCode}` : `healthcheck exited ${input.healthcheck?.exitCode ?? "?"}`) : null;
  const role = finishingRole(repo, running, actor);
  const events = [status === "succeeded" ? eventFor(ev, ctx, repo, actor, cycle, "deploy.finished", { env: running.env, version, sha: running.sha }, role) : eventFor(ev, ctx, repo, actor, cycle, "deploy.failed", { env: running.env, reason, sha: running.sha }, role)];
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path, content: stringifyYaml(replaceDeployment(record, index, entry)) }],
    events: events.map((e) => ev.write(e)),
    commitMessage: `sdlc(${view.id}): deploy ${running.env} ← ${short(running.sha)} ${status}`,
    trailers: trailers(events, actor),
    actor: planActor(actor, role),
  };
  return { ok: true, plan };
}

function deploymentEntry(env: ResolvedEnvironment, input: RecordDeploymentInput): Deployment {
  const healthy = !input.healthcheck || input.healthcheck.exitCode === 0;
  return {
    env: env.name,
    kind: env.kind,
    status: input.exitCode === 0 && healthy ? "succeeded" : "failed",
    sha: input.sha,
    version: versionOf(input),
    command: env.deployCommand,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? input.startedAt,
    exitCode: input.exitCode,
    output: clipOutput(input.output),
    actor: { type: input.actor.type, id: input.actor.id, ...(input.actor.session ? { session: input.actor.session } : {}) },
    ...(input.healthcheck ? { healthcheck: { ...input.healthcheck, output: clipOutput(input.healthcheck.output) } } : {}),
  };
}

function rehearsalEntry(env: ResolvedEnvironment, input: RecordRehearsalInput): RollbackRehearsal {
  return {
    env: env.name,
    kind: env.kind,
    sha: input.sha,
    status: input.exitCode === 0 ? "succeeded" : "failed",
    command: env.rollbackCommand,
    rehearsedAt: input.rehearsedAt,
    finishedAt: input.finishedAt ?? input.rehearsedAt,
    exitCode: input.exitCode,
    output: clipOutput(input.output),
    actor: { type: input.actor.type, id: input.actor.id, ...(input.actor.session ? { session: input.actor.session } : {}) },
  };
}

/** A rehearsal is at the commit the environment is running: its latest succeeded deployment. */
function rehearsalTarget(record: Deploy | null, env: ResolvedEnvironment, sha: string, path: string): Refusal | null {
  if (env.kind === "production") return refusal("rehearsal.production", `a rollback is rehearsed against a non-production environment, never ${env.name}; the rehearsal is what lets the production gate open`, path);
  const deployed = [...(record?.environments ?? [])].reverse().find((e) => e.env === env.name && e.status === "succeeded") ?? null;
  if (!deployed) return refusal("rehearsal.nothing-deployed", `nothing is deployed to ${env.name} yet; deploy there first, then rehearse the rollback`, path);
  if (deployed.sha !== sha) return refusal("rehearsal.sha-mismatch", `${env.name} is running ${short(deployed.sha)}, not ${short(sha)}; a rehearsal is recorded at the commit the environment has`, path);
  return null;
}

/** Record a deployment that already ran (a session's `deploy_<env>` call, recorded by the engine when the session ends). Non-production only. */
export function recordDeployment(repo: Repo, view: ChangeView, input: RecordDeploymentInput, ctx: TransitionContext): TransitionResult {
  return recordSessionDeploys(repo, view, [{ kind: "deploy", ...input }], input.actor, ctx);
}

/** Record a rollback rehearsal (3.6): the rollback command ran against a non-production environment at its deployed commit; the output is the evidence the production gate reads. */
export function recordRehearsal(repo: Repo, view: ChangeView, input: RecordRehearsalInput, ctx: TransitionContext): TransitionResult {
  return recordSessionDeploys(repo, view, [{ kind: "rehearsal", ...input }], input.actor, ctx);
}

/**
 * Record what a session did through `deploy_<env>` and `rehearse_rollback`,
 * in order, as one commit: every deployment and rehearsal onto deploy.yaml,
 * `deploy.started`/`deploy.finished`/`deploy.failed` and `rollback.rehearsed`
 * onto the ledger. Production is refused here: it has no recording path, only
 * the gate.
 */
export function recordSessionDeploys(repo: Repo, view: ChangeView, items: readonly SessionDeployItem[], actor: DeployActorInput, ctx: TransitionContext): TransitionResult {
  const l = loaded(repo, view);
  if (isRefusal(l)) return l;
  const { files, cycle } = l;
  const path = `${files.dir}/deploy.yaml`;
  if (items.length === 0) return refuse("deploy.nothing-to-record", "no deployment or rehearsal to record", path);
  const ev = new EventBuilder(ctx, files, view.id);
  const events: Event[] = [];
  let record: Deploy | null = files.deploy;
  const summary: string[] = [];
  for (const item of items) {
    const env = environment(repo, item.env, path);
    if (isRefusal(env)) return env;
    if (item.kind === "deploy") {
      if (env.kind === "production") return refuse("production.recorded-without-gate", `${env.name} deployments are recorded only by the production gate (a person's \`sdlc deploy ${env.name}\` or the console); a session cannot record one`, path);
      const entry = deploymentEntry(env, { ...item, actor });
      record = appendDeployment(record, entry);
      const version = entry.version ?? short(entry.sha);
      events.push(eventFor(ev, ctx, repo, actor, cycle, "deploy.started", { env: env.name, version, sha: entry.sha }));
      events.push(entry.status === "succeeded" ? eventFor(ev, ctx, repo, actor, cycle, "deploy.finished", { env: env.name, version, sha: entry.sha }) : eventFor(ev, ctx, repo, actor, cycle, "deploy.failed", { env: env.name, reason: `${env.deployCommand} exited ${entry.exitCode}`, sha: entry.sha }));
      summary.push(`deploy ${env.name} ← ${short(entry.sha)} ${entry.status}`);
    } else {
      const bad = rehearsalTarget(record, env, item.sha, path);
      if (bad) return bad;
      const entry = rehearsalEntry(env, { ...item, actor });
      record = appendRehearsal(record as Deploy, entry);
      events.push(eventFor(ev, ctx, repo, actor, cycle, "rollback.rehearsed", { env: env.name, sha: entry.sha, status: entry.status }));
      summary.push(`rollback rehearsed on ${env.name} at ${short(entry.sha)} ${entry.status}`);
    }
  }
  if (!record) return refuse("deploy.nothing-to-record", "no deployment or rehearsal to record", path);
  const role = actor.type === "human" ? (rolesOf(repo.config, actor.id)[0] ?? null) : null;
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path, content: stringifyYaml(record) }],
    events: events.map((e) => ev.write(e)),
    commitMessage: `sdlc(${view.id}): ${summary.join(" · ")}`,
    trailers: trailers(events, actor),
    actor: planActor(actor, role),
  };
  return { ok: true, plan };
}

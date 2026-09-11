import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchExists, commitWritePlan, newUlid, readTree, showPrefix, type GitIdentity } from "@sdlc/adapter-git";
import { check, deriveChange, harnessFor, loadRepo, logPath, normalizeReason, repeatSignals, stageDef, type ChangeView, type Repo, type RepeatSignal, type WritePlan } from "@sdlc/core";
import { claudeCodeHarness, harnessFromConfig, type Harness, type HarnessJob } from "./harness.js";
import { PROPOSAL_JOB, buildContext, readRounds, type ContextBundle, type StoredRound } from "@sdlc/mcp";
import type { Exec } from "../engine/runner.js";
import { noopTracer, type Tracer } from "../otel.js";
import type { Event } from "@sdlc/schemas";
import { ActionError } from "../store.js";
import { capacityOf } from "./capacity.js";
import { installExcerpt, installFailure, prepareWorktree } from "./install.js";
import { observe } from "./observer.js";
import { promptFor } from "./prompts.js";
import type { SessionKind, SessionRegistry, SessionStatus, StoredSession } from "./registry.js";

export type Mode = "AUTO" | "PLAN" | "SUPERVISED" | "HEADLESS";

export interface LaunchInput {
  changeId: string;
  kind?: SessionKind | undefined;
  taskId?: string | undefined;
  target?: string | undefined;
  mode?: Mode | undefined;
  engineer?: string | null | undefined;
  /** Relaunch an existing session with guidance (`claude --resume`). */
  resume?: { sessionId: string; guidance: string } | undefined;
  /** `propose` sessions: the repeat reason to answer (default: the first pending signal citing the change). */
  reason?: string | undefined;
}

export interface LaunchDeps {
  /** The SDLC home: the repository root, or a product's directory in a monorepo (3.2). */
  root: string;
  registry: SessionRegistry;
  /** Path to the sdlc bin, for the per-session MCP config. */
  sdlcBin: string;
  claudeBin?: string;
  identity: GitIdentity;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Called when a spawned session exits (snapshot rebuild). */
  onExit?: (session: StoredSession) => void;
  spawnImpl?: typeof spawn;
  /** OTel tracer (3.3): one `sdlc.session` span per launch, rounds as span events; the no-op tracer without an exporter. */
  tracer?: Tracer;
  /** Harness override (tests); otherwise `config.harness` per session kind, Claude Code by default (3.8). */
  harness?: Harness;
  /** Runs the dependency install (tests only); production callers leave it unset and `sh -c` runs the manager. */
  exec?: Exec;
}

export interface LaunchResult {
  session: StoredSession;
  /** Resolves when a spawned harness exits; immediate for SUPERVISED. */
  finished: Promise<number | null>;
}

const SYSTEM: GitIdentity = { id: "sdlc-bot@sdlc.local", name: "sdlc-bot" };

function kindForStage(view: ChangeView): SessionKind {
  return ({ 1: "intent", 2: "design", 3: "plan", 4: "build", 5: "build", 6: "diagnose" } as const)[view.stage];
}

function branchFor(kind: SessionKind, view: ChangeView, taskId: string | null): string {
  if (kind === "build") return `${view.id}/${taskId ?? "work"}`;
  // the review reads the PR branch as pushed; it never commits there (the PR head stays the tested head)
  if (kind === "review") return view.pr?.branch ?? `${view.id}/work`;
  // the proposal job reads; its branch is a throwaway cut from the default branch and nothing is committed on it
  if (kind === "propose") return `sdlc/propose/${view.id}`;
  const artifact = { intent: "intent", design: "spec", plan: "plan", diagnose: "incident" }[kind];
  return `sdlc/${view.id}/${artifact}`;
}

/** Where the branch's worktree is checked out; the session works in the home inside it (`<worktree>/<prefix>`). */
export function worktreePathFor(root: string, branch: string): string {
  return join(root, ".sdlc-state", "worktrees", branch.replace(/\//g, "__"));
}

/**
 * Claude Code's `plan` permission mode denies MCP tools (observed: get_context and
 * submit_plan_revision were refused), so plan sessions run in `default` mode and the
 * bundle's read-only allowedTools list is what keeps them from editing files.
 */
function permissionMode(mode: Mode, kind: SessionKind): "default" | "acceptEdits" {
  if (kind === "plan" || kind === "review" || kind === "propose" || mode === "PLAN") return "default";
  return "acceptEdits";
}

async function systemEventCommit(worktree: string, changeId: string, event: Event, message: string, who: GitIdentity): Promise<string> {
  const plan: WritePlan = { changeId, files: [], events: [{ changeId, event }], commitMessage: message, trailers: { "SDLC-Event": event.id, "SDLC-Actor": `${event.actor.type}:${event.actor.id}` }, actor: event.actor };
  return commitWritePlan(worktree, plan, { identity: who });
}

function nextSeq(repo: Repo, changeId: string, worktree: string): number {
  const files = repo.changes.get(changeId);
  let max = Math.max(0, ...(files?.events.map((e) => e.seq) ?? [0]));
  const abs = join(worktree, logPath(changeId));
  if (existsSync(abs)) {
    for (const line of require_fs().readFileSync(abs, "utf8").split(/\r?\n/)) {
      const m = /"seq":\s*(\d+)/.exec(line);
      if (m?.[1]) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

function require_fs(): typeof import("node:fs") {
  return fsModule;
}
import * as fsModule from "node:fs";

/**
 * Launch a Claude Code session for a change (blueprint §7.8, §8.3): prepare
 * the worktree and branch, write the per-session MCP config and prompt,
 * record `session.started` on the branch, spawn the harness headless and
 * observe it. SUPERVISED sessions are prepared, not spawned.
 */
export async function launchSession(input: LaunchInput, deps: LaunchDeps): Promise<LaunchResult> {
  const env = deps.env ?? process.env;
  const now = () => (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const repo = loadRepo(await readTree(deps.root, "HEAD"));
  const files = repo.changes.get(input.changeId);
  if (!files) throw new ActionError(404, `${input.changeId} not found`);
  const view = deriveChange(repo, files);
  if (!view.valid) throw new ActionError(409, `${view.id} has validation errors`, view.validationErrors);
  if (view.closed) throw new ActionError(409, `${view.id} is closed`);

  const kind = input.kind ?? kindForStage(view);
  if (kind === "build" && view.stage !== 4) throw new ActionError(409, `build sessions start once plan.md is accepted (stage 4); ${view.id} is at stage ${view.stage}`);
  if (kind === "plan" && view.stage !== 3) throw new ActionError(409, `plan sessions belong to stage 3; ${view.id} is at stage ${view.stage}`);
  if ((kind === "intent" && view.stage !== 1) || (kind === "design" && view.stage !== 2) || (kind === "diagnose" && view.stage !== 6)) {
    throw new ActionError(409, `${kind} session does not match stage ${view.stage}`);
  }
  if (kind === "review" && (view.stage !== 5 || !view.pr || view.pr.mergedAt !== undefined)) throw new ActionError(409, `review sessions belong to stage 5 with an open pull request; ${view.id} is at stage ${view.stage}`);
  let signal: RepeatSignal | null = null;
  if (kind === "propose") {
    // FR-43: the job answers one repeat reason; a reason already answered by a proposal is never drafted twice
    const signals = repeatSignals(repo);
    signal = input.reason ? (signals.find((x) => x.reason === normalizeReason(input.reason ?? "")) ?? null) : (signals.find((x) => x.proposal === null && x.citations.includes(view.id)) ?? null);
    if (!signal) throw new ActionError(409, input.reason ? `"${normalizeReason(input.reason)}" is not a repeat reason (two hook blocks or send-backs across sessions)` : `no repeat reason cites ${view.id} without a proposal`);
    if (signal.proposal) throw new ActionError(409, `${signal.proposal.id} (${signal.proposal.status}) already answers "${signal.reason}"; a new occurrence counts onto it`);
  }
  const taskId = input.taskId ?? (kind === "build" ? (view.tasks.find((t) => t.state !== "done")?.id ?? null) : null);
  const task = taskId ? view.tasks.find((t) => t.id === taskId) : undefined;
  const target = input.target ?? task?.target ?? (kind === "build" ? view.acceptanceLine : null);
  if (kind === "build" && (!target || target.trim() === "")) throw new ActionError(409, "waiting on you: define done — a build session needs a target (quantifiable: which tests, which endpoint, which mock)");

  let mode: Mode = input.mode ?? (kind === "plan" ? "PLAN" : kind === "build" ? (view.autoEligible.value ? "AUTO" : "SUPERVISED") : "HEADLESS");
  if (mode === "AUTO" && !view.autoEligible.value) {
    throw new ActionError(409, `AUTO is not eligible for ${view.id}: ${view.autoEligible.terms.filter((t) => !t.ok).map((t) => `${t.name} (${t.detail})`).join("; ")}`);
  }
  if (kind === "plan") mode = "PLAN";
  const capacity = capacityOf(deps.registry.list(), repo);
  if (capacity.over) throw new ActionError(409, `review backlog ${capacity.backlog} exceeds the ceiling ${capacity.ceiling} — review finished sessions before starting another`);

  const branch = branchFor(kind, view, taskId);
  if (kind === "review" && !(await branchExists(deps.root, branch))) throw new ActionError(409, `the PR branch ${branch} is not in this clone; the review reads the pushed head, it never recreates it`);
  // a monorepo product (3.2): the worktree checks out the whole repository; the session lives in the product's home inside it
  const prefix = await showPrefix(deps.root);
  const checkout = worktreePathFor(deps.root, branch);
  const worktree = prefix === "" ? checkout : join(checkout, prefix.replace(/\/$/, ""));
  // a review session's own ledger lines are lifecycle records: they commit on the default branch, not on the PR branch
  const ledgerDir = kind === "review" || kind === "propose" ? deps.root : worktree;
  // the worktree, then its dependencies (CHG-0007): a failed install refuses the launch before any record, ledger line or process; the checkout stays for the retry
  const prepared = await prepareWorktree(deps.root, branch, { checkout, defaultBranch: repo.config.defaultBranch, env, ...(deps.exec ? { exec: deps.exec } : {}), ...(deps.now ? { now: deps.now } : {}) });
  if (prepared.install && prepared.install.exitCode !== 0) throw installFailure(checkout, prepared.install);
  const homeEnv = prefix === "" ? {} : { SDLC_HOME: prefix.replace(/\/$/, "") };

  const resuming = input.resume ?? null;
  const id = resuming?.sessionId ?? `sess-${newUlid().slice(-10).toLowerCase()}`;
  const existing = resuming ? deps.registry.get(resuming.sessionId) : null;
  const harnessSessionId = existing?.harnessSessionId ?? randomUUID();
  const stateDir = join(worktree, ".sdlc-state", "sessions", id);
  mkdirSync(stateDir, { recursive: true });
  if (prepared.install) writeFileSync(join(stateDir, "install.log"), prepared.install.output);
  const mcpConfig = join(stateDir, "mcp.json");
  writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: { sdlc: { command: "node", args: [deps.sdlcBin, "mcp"], env: { SDLC_SESSION: id, SDLC_CHANGE: view.id, SDLC_ACTOR_TYPE: "agent", ...homeEnv } } } }, null, 2)}\n`);
  const bundle: ContextBundle = buildContext(repo, view, kind === "propose" ? PROPOSAL_JOB : undefined);
  const prompt = resuming ? resuming.guidance : promptFor(kind, { view, bundle, sessionId: id, target, reviewPolicy: repo.reviewPolicy?.text ?? null, signal, claudeMd: repo.claudeMd ? { wordCount: repo.claudeMd.wordCount, text: readFileSync(join(deps.root, "CLAUDE.md"), "utf8") } : null });
  writeFileSync(join(stateDir, "prompt.md"), prompt);
  writeFileSync(join(stateDir, "context.json"), `${JSON.stringify(bundle, null, 2)}\n`);

  const claudeBin = deps.claudeBin ?? env["SDLC_CLAUDE_BIN"] ?? "claude";
  // the harness (3.8): from config per session kind; Claude Code with every guarantee when none is declared
  const harness = deps.harness ?? harnessFromConfig(harnessFor(repo.config.harnesses, kind), claudeBin);
  const job: HarnessJob = { sessionId: id, harnessSessionId, kind, mode, changeId: view.id, prompt, promptFile: join(stateDir, "prompt.md"), mcpConfig, allowedTools: bundle.allowedTools, permissionMode: permissionMode(mode, kind), resume: resuming !== null, worktree };
  const command = harness.engineerCommand({ worktree, sessionId: id, changeId: view.id, harnessSessionId, permissionMode: job.permissionMode, mcpConfig, resume: resuming !== null });
  const transcriptPath = join(stateDir, harness.capabilities.transcript ? "stream.jsonl" : "output.log");
  // the session's span: a resume is a child in the same trace as the launch it continues
  const tracer = deps.tracer ?? noopTracer;
  const parent = existing?.traceId && existing.spanId ? { traceId: existing.traceId, spanId: existing.spanId } : null;
  const span = tracer.startSpan(resuming ? "sdlc.session.resume" : "sdlc.session", {
    attributes: { "sdlc.session.id": id, "sdlc.session.kind": kind, "sdlc.session.mode": mode, "sdlc.change": view.id, "sdlc.cycle": view.cycle, "sdlc.stage": view.stage, "sdlc.task": taskId, "sdlc.branch": branch, "sdlc.session.engineer": input.engineer ?? deps.identity.id, "sdlc.session.resume_count": resuming ? (existing?.resumeCount ?? 0) + 1 : 0, "sdlc.session.harness_id": harnessSessionId, "sdlc.session.harness": harness.id, "sdlc.session.degraded": harness.degraded.map((d) => d.guarantee).join(","), "sdlc.install.manager": prepared.install?.manager ?? null, "sdlc.install.exit_code": prepared.install?.exitCode ?? null, "sdlc.install.duration_ms": prepared.install?.durationMs ?? null },
    parent,
  });
  if (prepared.install) span.addEvent("sdlc.install", { "sdlc.install.manager": prepared.install.manager, "sdlc.install.command": prepared.install.command, "sdlc.install.exit_code": prepared.install.exitCode, "sdlc.install.duration_ms": prepared.install.durationMs }, Date.parse(prepared.install.startedAt) || undefined);

  const record: StoredSession = {
    ...(existing ?? {}),
    id,
    kind,
    cycle: view.cycle,
    resumeCount: resuming ? (existing?.resumeCount ?? 0) + 1 : 0,
    worktree: branch,
    worktreePath: worktree,
    branch,
    changeId: view.id,
    taskId,
    mode,
    engineer: input.engineer ?? deps.identity.id,
    startedAt: existing?.startedAt ?? now(),
    heartbeatAt: now(),
    status: mode === "SUPERVISED" ? "awaiting_engineer" : "running",
    target,
    files: task?.files ?? view.planFiles,
    subagents: repo.agents.map((a) => ({ name: a.name, state: "idle" })),
    loop: { state: "not-run", rounds: [] },
    verifier: null,
    testEditAttempts: 0,
    waitingOnYou: null,
    autoRationale: { terms: view.autoEligible.terms.map((t) => `${t.ok ? "✓" : "✗"} ${t.name} — ${t.detail}`) },
    modelPin: existing?.modelPin ?? null,
    contextManifestRef: bundle.manifest,
    transcriptRef: transcriptPath,
    harnessSessionId,
    harness: { id: harness.id, degraded: harness.degraded },
    standIn: null,
    install: prepared.install,
    pid: null,
    exitCode: null,
    command,
    capRaised: existing?.capRaised ?? false,
    reviewed: false,
    costUsd: existing?.costUsd ?? null,
    numTurns: existing?.numTurns ?? null,
    lastLine: null,
    error: null,
    traceId: span.traceId ?? existing?.traceId ?? null,
    spanId: span.spanId ?? existing?.spanId ?? null,
  };
  deps.registry.upsert(record);

  if (!resuming) {
    const started: Event = { schema: 1, id: newUlid(), ts: now(), seq: nextSeq(repo, view.id, ledgerDir), cycle: view.cycle, actor: { type: "system", id: SYSTEM.id }, event: "session.started", data: { session: id, mode, ...(taskId ? { task: taskId } : {}), worktree: branch, ...(target ? { target } : {}), harness: { id: harness.id, degraded: harness.degraded }, ...(prepared.install ? { install: { manager: prepared.install.manager, command: prepared.install.command, exitCode: prepared.install.exitCode, outputExcerpt: installExcerpt(prepared.install.output) } } : {}) } } as Event;
    const sha = await systemEventCommit(ledgerDir, view.id, started, `sdlc(${view.id}): session ${id} started (${mode})`, SYSTEM);
    span.addEvent("sdlc.ledger.session.started", { "sdlc.event.id": started.id, "sdlc.commit": sha });
  }

  if (mode === "SUPERVISED") {
    // the console's part ends here: the engineer runs the command in their terminal
    span.setAttributes({ "sdlc.session.status": "awaiting_engineer" });
    span.end({ ok: true });
    return { session: record, finished: Promise.resolve(null) };
  }

  // the harness's own git commits are attributed to the agent identity (§12.4), not to the engineer who launched it (sessionEnv in the adapter)
  const { child, output } = harness.launch(job, { cwd: worktree, env: { ...env, ...homeEnv }, spawnImpl: deps.spawnImpl });
  deps.registry.patch(id, { pid: child.pid ?? null });
  const finished = observe(child, deps.registry, id, {
    transcriptPath,
    output,
    ...(deps.now ? { now: deps.now } : {}),
    // no Stop hook: the console applies the hook's rule itself to the rounds the session recorded (3.8)
    finalStatus: (status) => (status === "done" && !harness.capabilities.hooks.Stop ? standInForStop(worktree, id) : { status }),
    onExit: async (_code, { status }) => {
      const after = loadRepo(await readTree(ledgerDir, "HEAD").catch(() => repo.tree));
      const files2 = after.changes.get(view.id);
      const alreadyStopped = files2?.events.some((e) => e.event === "session.stopped" && e.data.session === id) ?? false;
      if (!alreadyStopped) {
        const reason = status === "done" ? "done" : status === "done-unverified" ? "unverified" : status === "taken_over" || status === "awaiting_engineer" ? "taken_over" : status === "stopped" ? "stopped" : "error";
        const stopped: Event = { schema: 1, id: newUlid(), ts: now(), seq: nextSeq(after, view.id, ledgerDir), cycle: view.cycle, actor: { type: "system", id: SYSTEM.id }, event: "session.stopped", data: { session: id, reason } } as Event;
        // the ledger line is the record of the exit; another commit on the same branch (an index lock) is retried, never lost silently
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const sha = await systemEventCommit(ledgerDir, view.id, stopped, `sdlc(${view.id}): session ${id} ${reason}`, SYSTEM);
            span.addEvent("sdlc.ledger.session.stopped", { "sdlc.event.id": stopped.id, "sdlc.commit": sha, "sdlc.session.stop_reason": reason });
            break;
          } catch (e) {
            if (attempt === 4) deps.registry.patch(id, { error: `session.stopped not recorded: ${(e as Error).message}` });
            else await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          }
        }
      }
      const final = deps.registry.get(id);
      // rounds the session recorded (its verification loop) become events on the span; the span ends with the harness
      const rounds = existsSync(worktree) ? (readRounds(worktree, id) as StoredRound[]) : [];
      for (const r of rounds) span.addEvent("sdlc.round", { "sdlc.round.n": r.n, "sdlc.round.pass": r.results.every((x) => x.pass), "sdlc.round.results": r.results.map((x) => `${x.name}:${x.pass ? "pass" : "fail"}`).join(","), ...(r.diffPct !== undefined ? { "sdlc.round.diff_pct": r.diffPct } : {}) }, Date.parse(r.ts) || undefined);
      span.setAttributes({ "sdlc.session.status": status, "sdlc.session.exit_code": _code, "sdlc.session.rounds": rounds.length, "sdlc.session.cost_usd": final?.costUsd ?? null, "sdlc.session.turns": final?.numTurns ?? null, "sdlc.session.model": final?.modelPin ?? null });
      span.end(status === "error" ? { ok: false, ...(final?.error ? { message: final.error } : {}) } : { ok: true });
      if (final) deps.onExit?.(final);
    },
  });
  return { session: deps.registry.get(id) ?? record, finished };
}

/** Kill a running session's harness; the observer records the final status. */
export function stopSession(registry: SessionRegistry, id: string, status: "stopped" | "taken_over" = "stopped"): StoredSession {
  const s = registry.get(id);
  if (!s) throw new ActionError(404, `${id} not found`);
  const patched = registry.patch(id, { status, heartbeatAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  if (s.pid) {
    try {
      process.kill(s.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  return patched ?? s;
}

export { stageDef };

/**
 * verify-before-done without a Stop hook (3.8): the same rule the hook applies
 * (`check.verifyBeforeDone`) over the rounds the session recorded through
 * `report_round`. Green → done; anything else → `done-unverified`, and the
 * verdict is kept on the record verbatim.
 */
export function standInForStop(worktree: string, sessionId: string): { status: SessionStatus; patch: Partial<StoredSession> } {
  const rounds = existsSync(worktree) ? (readRounds(worktree, sessionId) as StoredRound[]) : [];
  const verdict = check.verifyBeforeDone(rounds);
  const standIn = { guarantee: "verify-before-done", allowed: verdict.allowed, reason: verdict.reason, rounds: rounds.length };
  return { status: verdict.allowed ? "done" : "done-unverified", patch: { standIn } };
}

/** The interactive command handed to the engineer for a SUPERVISED session (or one downgraded to it): same worktree, same MCP config, same harness session. */
export function engineerCommand(s: Pick<StoredSession, "worktreePath" | "id" | "changeId" | "harnessSessionId" | "kind" | "mode">, claudeBin = "claude", resume = false, harness: Harness = claudeCodeHarness(claudeBin)): string {
  const mcpConfig = join(s.worktreePath, ".sdlc-state", "sessions", s.id, "mcp.json");
  return harness.engineerCommand({ worktree: s.worktreePath, sessionId: s.id, changeId: s.changeId, harnessSessionId: s.harnessSessionId, permissionMode: permissionMode(s.mode, s.kind), mcpConfig, resume });
}

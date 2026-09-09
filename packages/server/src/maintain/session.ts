import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, currentBranch, gitRaw, newUlid, showPrefix, type GitIdentity } from "@sdlc/adapter-git";
import { breachEvidence, routesOf, type BandStatus } from "@sdlc/core";
import type { ControlBand, MetricSnapshot } from "@sdlc/schemas";
import { noopTracer, type Tracer } from "../otel.js";
import { observe } from "../sessions/observer.js";
import { worktreePathFor } from "../sessions/launcher.js";
import type { SessionRegistry, StoredSession } from "../sessions/registry.js";

const AGENT: GitIdentity = { id: "claude-code@sdlc.local", name: "claude-code" };

export interface BandLaunchInput {
  band: ControlBand;
  snapshot: MetricSnapshot;
  tier: 2 | 3;
  triageId: string;
  /** The engine job that owns the session (part of the idempotency story: one session per job). */
  job: string;
  status: BandStatus;
  /** Snapshot history for the prompt (oldest first). */
  history: readonly MetricSnapshot[];
}

export interface BandLaunchDeps {
  root: string;
  registry: SessionRegistry;
  sdlcBin: string;
  claudeBin?: string;
  identity: GitIdentity;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  onExit?: (session: StoredSession) => void;
  spawnImpl?: typeof spawn;
  tracer?: Tracer;
  /** The repository's default branch (the worktree is cut from it). */
  defaultBranch: string;
}

/** Branch a band session works on: the propose route's pull request comes from here; a diagnose session reads here. */
export function bandBranch(metric: string): string {
  return `sdlc/maintain/${metric.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

/**
 * Tools a band session gets (blueprint Stage 06 "Agent interface"): exactly
 * the 2σ tier's `tools` plus the diagnosis tool; at 3σ the `pr` route adds
 * editing and committing on the session's own branch, a `runbook:<id>`
 * route adds `run_runbook`. Nothing merges, pushes to the default branch or
 * touches production credentials — the propose job's writes are its branch,
 * the triage queue and the allowlisted runbook.
 */
export function bandTools(band: ControlBand, tier: 2 | 3): string[] {
  const tools = [...band.tiers["2sigma"].tools, "mcp__sdlc__report_diagnosis"];
  if (tier === 3) {
    const routes = routesOf(band);
    if (routes.pr) tools.push("Edit", "Write", "Bash(git add *)", "Bash(git commit *)", "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)");
    if (routes.runbooks.length > 0) tools.push("mcp__sdlc__run_runbook");
  }
  return [...new Set(tools)];
}

/** PB-S6 step 5: the agent diagnoses in intent format, read-only at 2σ; at 3σ it may also propose through the routes bands.yaml lists. */
export function bandPrompt(input: BandLaunchInput, sessionId: string): string {
  const { band, snapshot, tier, triageId } = input;
  const unit = band.unit ? ` ${band.unit}` : "";
  const recent = input.history.slice(-8).map((s) => `- ${s.ts}: ${s.current ?? "no data"}${unit}${s.tier !== null ? ` (${s.tier}σ)` : ""}`).join("\n");
  const routes = routesOf(band);
  const propose = tier === 3
    ? `\n\nThis is a 3σ propose session. Beyond the diagnosis you may${routes.pr ? " commit a proposed fix on this branch (git add, git commit; the console opens the pull request into the review gate when you finish — you never push, merge or touch the default branch)" : ""}${routes.pr && routes.runbooks.length > 0 ? " and/or" : ""}${routes.runbooks.length > 0 ? ` trigger a pre-approved runbook with mcp__sdlc__run_runbook (ids: ${routes.runbooks.join(", ")}) — the command is fixed by bands.yaml, runs once, and its output is recorded verbatim` : ""}. Do only what the evidence supports.`
    : "\n\nThis is a 2σ diagnose session: read-only. Do not edit files, run deployments or commit.";
  return `You are diagnosing a control-band breach in an AI-native SDLC (Maintain stage). Files in git are the source of truth; humans decide at gates; you never accept, merge, approve or deploy anything.
Your session id is ${sessionId}. Use the sdlc MCP tools (mcp__sdlc__*) with sessionId "${sessionId}".

Breach: ${band.metric} = ${snapshot.current ?? "?"}${unit} against a baseline of ${band.baseline}${unit} (σ ${snapshot.sigma ?? "?"}), tier ${tier}σ at ${snapshot.ts}. Triage item ${triageId} is already open with this evidence:
${breachEvidence({ band, snapshot }).trimEnd()}

Recent samples:
${recent || "- (none)"}

Task: find the most likely cause using the tools you have (this worktree is the repository at ${input.status.ts ?? snapshot.ts}; read code, history and CI runs as allowed). Then call mcp__sdlc__report_diagnosis once with metric "${band.metric}", a one-line title, and intent-format sections: problem (what changed and the evidence), proposedOutcome (measurable), affected (users and systems), constraints, openQuestions. Be concrete; cite files, commits and run ids. The diagnosis lands on ${triageId} for a human to accept into a change or dismiss.${propose}`;
}

/**
 * Launch a headless diagnose (2σ) or propose (3σ) session for a breached
 * band (build-order 3.4): worktree on `sdlc/maintain/<metric>` cut from the
 * default branch, per-session MCP config carrying the band and tier, the
 * tier's tools as the harness allowlist. No change, no ledger: the triage
 * item is the record, and the session's output lands there when it ends.
 */
export async function launchBandSession(input: BandLaunchInput, deps: BandLaunchDeps): Promise<{ session: StoredSession; finished: Promise<number | null> }> {
  const env = deps.env ?? process.env;
  const now = () => (deps.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const kind = input.tier === 3 ? "propose" : "diagnose";
  const branch = bandBranch(input.band.metric);
  const prefix = await showPrefix(deps.root);
  const checkout = worktreePathFor(deps.root, branch);
  const worktree = prefix === "" ? checkout : join(checkout, prefix.replace(/\/$/, ""));
  if (!existsSync(checkout)) {
    mkdirSync(join(deps.root, ".sdlc-state", "worktrees"), { recursive: true });
    await gitRaw(deps.root, ["worktree", "prune"]);
    const onBase = (await currentBranch(deps.root)) === deps.defaultBranch ? "HEAD" : deps.defaultBranch;
    await addWorktree(deps.root, checkout, branch, onBase);
  }
  const homeEnv = prefix === "" ? {} : { SDLC_HOME: prefix.replace(/\/$/, "") };
  const id = `sess-${newUlid().slice(-10).toLowerCase()}`;
  const harnessSessionId = randomUUID();
  const stateDir = join(worktree, ".sdlc-state", "sessions", id);
  mkdirSync(stateDir, { recursive: true });
  const bandEnv = { SDLC_BAND: input.band.metric, SDLC_BAND_TIER: String(input.tier), SDLC_TRIAGE: input.triageId };
  const mcpConfig = join(stateDir, "mcp.json");
  writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: { sdlc: { command: "node", args: [deps.sdlcBin, "mcp"], env: { SDLC_SESSION: id, SDLC_ACTOR_TYPE: "agent", ...bandEnv, ...homeEnv } } } }, null, 2)}\n`);
  const prompt = bandPrompt(input, id);
  writeFileSync(join(stateDir, "prompt.md"), prompt);
  const allowedTools = bandTools(input.band, input.tier);
  writeFileSync(join(stateDir, "context.json"), `${JSON.stringify({ job: kind, band: input.band.metric, tier: input.tier, triage: input.triageId, snapshot: input.snapshot, allowedTools, promptRef: `prompts/band-${kind}@1` }, null, 2)}\n`);
  const claudeBin = deps.claudeBin ?? env["SDLC_CLAUDE_BIN"] ?? "claude";
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", input.tier === 3 && routesOf(input.band).pr ? "acceptEdits" : "default", "--mcp-config", mcpConfig, "--allowedTools", ...allowedTools, "--session-id", harnessSessionId];
  const tracer = deps.tracer ?? noopTracer;
  const span = tracer.startSpan("sdlc.session", { attributes: { "sdlc.session.id": id, "sdlc.session.kind": kind, "sdlc.session.mode": "HEADLESS", "sdlc.band": input.band.metric, "sdlc.band.tier": input.tier, "sdlc.triage": input.triageId, "sdlc.job.key": input.job, "sdlc.branch": branch, "sdlc.session.harness_id": harnessSessionId }, parent: null });
  const record: StoredSession = {
    id,
    kind,
    cycle: 0,
    resumeCount: 0,
    worktree: branch,
    worktreePath: worktree,
    branch,
    changeId: "",
    taskId: null,
    mode: "HEADLESS",
    engineer: deps.identity.id,
    startedAt: now(),
    heartbeatAt: now(),
    status: "running",
    target: null,
    files: [],
    subagents: [],
    loop: { state: "not-run", rounds: [] },
    verifier: null,
    testEditAttempts: 0,
    waitingOnYou: null,
    autoRationale: { terms: [] },
    modelPin: null,
    contextManifestRef: join(stateDir, "context.json"),
    transcriptRef: join(stateDir, "stream.jsonl"),
    harnessSessionId,
    pid: null,
    exitCode: null,
    command: "",
    capRaised: false,
    reviewed: false,
    costUsd: null,
    numTurns: null,
    lastLine: null,
    error: null,
    traceId: span.traceId ?? null,
    spanId: span.spanId ?? null,
    band: { metric: input.band.metric, tier: input.tier, snapshotTs: input.snapshot.ts, triageId: input.triageId, job: input.job },
  };
  deps.registry.upsert(record);
  const child = (deps.spawnImpl ?? spawn)(claudeBin, args, {
    cwd: worktree,
    // no production credentials reach the session: only what the console itself runs with, plus the band identifiers
    env: { ...env, SDLC_SESSION: id, SDLC_ACTOR_TYPE: "agent", SDLC_AGENT_ID: AGENT.id, GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.id, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.id, ...bandEnv, ...homeEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  deps.registry.patch(id, { pid: child.pid ?? null });
  const finished = observe(child, deps.registry, id, {
    transcriptPath: join(stateDir, "stream.jsonl"),
    ...(deps.now ? { now: deps.now } : {}),
    onExit: (_code, { status }) => {
      const final = deps.registry.get(id);
      span.setAttributes({ "sdlc.session.status": status, "sdlc.session.exit_code": _code, "sdlc.session.cost_usd": final?.costUsd ?? null, "sdlc.session.turns": final?.numTurns ?? null, "sdlc.session.model": final?.modelPin ?? null });
      span.end(status === "error" ? { ok: false, ...(final?.error ? { message: final.error } : {}) } : { ok: true });
      if (final) deps.onExit?.(final);
    },
  });
  return { session: deps.registry.get(id) ?? record, finished };
}

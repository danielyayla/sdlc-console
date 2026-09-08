import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_HARNESS_ID, COMMAND_HARNESS_CAPABILITIES, degradedGuarantees, type DegradedGuarantee, type HarnessCapabilities, type ResolvedHarness } from "@sdlc/core";

/** What the launcher has prepared for one session, whichever harness runs it. */
export interface HarnessJob {
  sessionId: string;
  harnessSessionId: string;
  kind: string;
  mode: string;
  changeId: string;
  prompt: string;
  promptFile: string;
  /** Per-session MCP config (`{ mcpServers: { sdlc: … } }`), the file Claude Code takes as `--mcp-config`. */
  mcpConfig: string;
  allowedTools: readonly string[];
  /** `default` keeps the harness asking before edits (plan, review, propose sessions); `acceptEdits` lets it edit. */
  permissionMode: "default" | "acceptEdits";
  /** True when the session continues an earlier one with guidance. */
  resume: boolean;
  worktree: string;
}

export interface HarnessContext {
  cwd: string;
  env: Record<string, string | undefined>;
  spawnImpl?: typeof spawn | undefined;
}

export interface RunningHarness {
  child: ChildProcess;
  /** What stdout carries: Claude's stream-json (parsed by the observer) or plain lines (kept verbatim). */
  output: "stream-json" | "text";
}

export interface HarnessSpawnSpec {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A harness adapter (blueprint §8.11, build-order 3.8): declares what it
 * honours, turns a prepared job into a process, and hands the engineer the
 * same session as a shell command when the mode is SUPERVISED. Everything
 * before (worktree, prompt, MCP config, ledger) and after (observer,
 * stand-ins, records) is the launcher's, so a second harness changes the
 * process line and nothing else.
 */
export interface Harness {
  id: string;
  capabilities: HarnessCapabilities;
  /** The guarantees this harness cannot honour, as shown on the session and written to `session.started`. */
  degraded: DegradedGuarantee[];
  spawnSpec(job: HarnessJob): HarnessSpawnSpec;
  launch(job: HarnessJob, context: HarnessContext): RunningHarness;
  /** Interactive form of the same session for the engineer's terminal (SUPERVISED, downgrade). */
  engineerCommand(job: Pick<HarnessJob, "worktree" | "sessionId" | "changeId" | "harnessSessionId" | "permissionMode" | "mcpConfig" | "resume">): string;
}

const AGENT = { id: "claude-code@sdlc.local", name: "claude-code" };

/** Environment every harness gets: the session, the change, the agent identity for its git commits and where the console's files are. */
export function sessionEnv(job: Pick<HarnessJob, "sessionId" | "changeId" | "promptFile" | "mcpConfig" | "allowedTools" | "harnessSessionId" | "permissionMode" | "resume">): Record<string, string> {
  return {
    SDLC_SESSION: job.sessionId,
    ...(job.changeId ? { SDLC_CHANGE: job.changeId } : {}),
    SDLC_ACTOR_TYPE: "agent",
    SDLC_AGENT_ID: AGENT.id,
    GIT_AUTHOR_NAME: AGENT.name,
    GIT_AUTHOR_EMAIL: AGENT.id,
    GIT_COMMITTER_NAME: AGENT.name,
    GIT_COMMITTER_EMAIL: AGENT.id,
    SDLC_PROMPT_FILE: job.promptFile,
    SDLC_MCP_CONFIG: job.mcpConfig,
    SDLC_ALLOWED_TOOLS: job.allowedTools.join(","),
    SDLC_HARNESS_SESSION: job.harnessSessionId,
    SDLC_READ_ONLY: job.permissionMode === "default" ? "1" : "0",
    SDLC_RESUME: job.resume ? "1" : "0",
  };
}

const PROMPT_SENTINEL = "\u0000prompt\u0000";

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** Claude Code headless: `claude -p <prompt> --output-format stream-json …` (decisions 1.6, amended 1.6 → e2e); every guarantee honoured natively. */
export function claudeCodeHarness(bin = "claude"): Harness {
  const spawnSpec = (job: HarnessJob): HarnessSpawnSpec => ({
    bin,
    args: ["-p", job.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", job.permissionMode, "--mcp-config", job.mcpConfig, "--allowedTools", ...job.allowedTools, ...(job.resume ? ["--resume", job.harnessSessionId] : ["--session-id", job.harnessSessionId])],
    env: sessionEnv(job),
  });
  return {
    id: CLAUDE_CODE_HARNESS_ID,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    degraded: degradedGuarantees(CLAUDE_CODE_CAPABILITIES),
    spawnSpec,
    launch(job, context) {
      const spec = spawnSpec(job);
      const child = (context.spawnImpl ?? spawn)(spec.bin, spec.args, { cwd: context.cwd, env: { ...context.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"] });
      return { child, output: "stream-json" };
    },
    engineerCommand(s) {
      return `cd ${s.worktree} && SDLC_SESSION=${s.sessionId} SDLC_CHANGE=${s.changeId} GIT_AUTHOR_NAME=${AGENT.name} GIT_AUTHOR_EMAIL=${AGENT.id} GIT_COMMITTER_NAME=${AGENT.name} GIT_COMMITTER_EMAIL=${AGENT.id} ${bin} ${s.resume ? `--resume ${s.harnessSessionId}` : `--session-id ${s.harnessSessionId}`} --mcp-config ${s.mcpConfig} --permission-mode ${s.permissionMode}`;
    },
  };
}

/** The `{placeholders}` a command harness may use in its args and env values. */
export function placeholders(job: HarnessJob): Record<string, string> {
  return {
    prompt: job.prompt,
    promptFile: job.promptFile,
    mcpConfig: job.mcpConfig,
    allowedTools: job.allowedTools.join(","),
    worktree: job.worktree,
    sessionId: job.sessionId,
    harnessSessionId: job.harnessSessionId,
    changeId: job.changeId,
    readOnly: job.permissionMode === "default" ? "1" : "0",
  };
}

export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (m, key: string) => (key in values ? (values[key] ?? "") : m));
}

/**
 * A generic command harness (3.8): any CLI agent, started with the config's
 * command and args in the session worktree, the prompt file, the MCP config
 * and the allowed-tools list handed over by placeholder and by `SDLC_*` env.
 * It declares no hooks, no allowlist, no transcript and no cost: the console
 * stands in server-side where a real check exists (verify-before-done at exit,
 * plan-sync and test-freeze on the per-change run) and shows the rest as gaps.
 */
export function commandHarness(spec: Pick<ResolvedHarness, "id" | "command" | "args" | "env">): Harness {
  if (!spec.command) throw new Error(`harness ${spec.id}: no command`);
  const command = spec.command;
  const spawnSpec = (job: HarnessJob): HarnessSpawnSpec => {
    const values = placeholders(job);
    return {
      bin: substitute(command, values),
      args: spec.args.map((a) => substitute(a, values)),
      env: { ...sessionEnv(job), ...Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, substitute(v, values)])) },
    };
  };
  return {
    id: spec.id,
    capabilities: COMMAND_HARNESS_CAPABILITIES,
    degraded: degradedGuarantees(COMMAND_HARNESS_CAPABILITIES),
    spawnSpec,
    launch(job, context) {
      const s = spawnSpec(job);
      const child = (context.spawnImpl ?? spawn)(s.bin, s.args, { cwd: context.cwd, env: { ...context.env, ...s.env }, stdio: ["ignore", "pipe", "pipe"] });
      return { child, output: "text" };
    },
    engineerCommand(s) {
      // the same process line the console would run, with the prompt read from its file in place of the prompt text
      const promptFile = join(s.worktree, ".sdlc-state", "sessions", s.sessionId, "prompt.md");
      const job: HarnessJob = { sessionId: s.sessionId, harnessSessionId: s.harnessSessionId, kind: "", mode: "SUPERVISED", changeId: s.changeId, prompt: PROMPT_SENTINEL, promptFile, mcpConfig: s.mcpConfig, allowedTools: [], permissionMode: s.permissionMode, resume: s.resume, worktree: s.worktree };
      const line = spawnSpec(job);
      const render = (v: string): string => (v === PROMPT_SENTINEL ? `"$(cat ${shellQuote(promptFile)})"` : shellQuote(v));
      const env = Object.entries(line.env).map(([k, v]) => `${k}=${render(v)}`).join(" ");
      return `cd ${s.worktree} && ${env} ${render(line.bin)} ${line.args.map(render).join(" ")}`.trim();
    },
  };
}

/** The adapter for a resolved config entry; `claudeBin` is the launcher's default executable when the entry names none. */
export function harnessFromConfig(entry: ResolvedHarness, claudeBin: string): Harness {
  return entry.kind === "command" ? commandHarness(entry) : claudeCodeHarness(entry.bin ?? claudeBin);
}

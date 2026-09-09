import type { HarnessJobKind, HarnessSpec } from "@sdlc/schemas";

/**
 * The harness contract (blueprint §8.11, build-order 3.8): what a harness
 * can be relied on to honour. Claude Code honours everything; a generic
 * command harness honours only what the console can hand over (a working
 * directory, the prompt, the MCP config). Nothing here launches anything —
 * the server's harness adapters do; this is the vocabulary they declare in
 * and the pure computation of what is missing.
 */
export interface HarnessCapabilities {
  /** Managed hooks the harness runs in-process (`sdlc hook <name>` through PreToolUse / PostToolUse / Stop). */
  hooks: { PreToolUse: boolean; PostToolUse: boolean; Stop: boolean };
  tools: {
    /** Speaks MCP: the console's tools reach it through the per-session config. */
    mcp: boolean;
    /** Honours an allowed-tools list (read-only sessions, band tiers). */
    allowlist: boolean;
    /** Works in the directory it is started in (the session worktree). */
    worktree: boolean;
  };
  /** Emits a structured transcript the observer reads (model pin, turns, result). */
  transcript: boolean;
  /** Reports its cost. */
  cost: boolean;
}

/** One managed guarantee the harness cannot honour, with what the console does instead (or that nothing can). Shown verbatim on the session and recorded on `session.started`. */
export interface DegradedGuarantee {
  guarantee: string;
  reason: string;
}

export const CLAUDE_CODE_HARNESS_ID = "claude-code";

export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  hooks: { PreToolUse: true, PostToolUse: true, Stop: true },
  tools: { mcp: true, allowlist: true, worktree: true },
  transcript: true,
  cost: true,
};

/** A CLI agent the console only starts: it gets the prompt and the MCP config; nothing else can be relied on. */
export const COMMAND_HARNESS_CAPABILITIES: HarnessCapabilities = {
  hooks: { PreToolUse: false, PostToolUse: false, Stop: false },
  tools: { mcp: true, allowlist: false, worktree: true },
  transcript: false,
  cost: false,
};

/**
 * The guarantees a harness with these capabilities cannot honour, each with
 * the console's stand-in where one exists. The order is the display order.
 * The reasons are the literal chips: they say what is enforced instead, or
 * that nothing is, and never soften the gap.
 */
export function degradedGuarantees(caps: HarnessCapabilities): DegradedGuarantee[] {
  const out: DegradedGuarantee[] = [];
  if (!caps.hooks.Stop) out.push({ guarantee: "verify-before-done", reason: "no Stop hook — done is unverified unless the last recorded round is green with output; a red or missing round ends the session done-unverified and no run follows" });
  if (!caps.hooks.PreToolUse) {
    out.push({ guarantee: "test-freeze", reason: "no PreToolUse hook — test edits during a fix are not blocked in the session; the per-change run raises a test-freeze auto-finding per file that blocks the merge until a human dismisses it" });
    out.push({ guarantee: "plan-sync", reason: "no PreToolUse hook — commits outside plan.md are not blocked in the session; the per-change run checks the diff against \"Files that change\" and fails the plan-sync check instead" });
    out.push({ guarantee: "production-gate", reason: "no PreToolUse hook — a production command typed in the session's shell is not blocked; nothing stands in for it in-process (production stays behind the human gate: no MCP tool deploys it, deploy.authorized is human-only)" });
  }
  if (!caps.tools.mcp) out.push({ guarantee: "mcp", reason: "no MCP — the session cannot report rounds, done, findings or diagnoses; it ends done-unverified" });
  if (!caps.tools.allowlist) out.push({ guarantee: "tool-allowlist", reason: "no tool allowlist — read-only sessions and band tiers are not scoped by the harness; only the MCP server's own refusals apply" });
  if (!caps.tools.worktree) out.push({ guarantee: "worktree", reason: "no working-directory isolation — the session may write outside its worktree" });
  if (!caps.transcript) out.push({ guarantee: "transcript", reason: "no structured transcript — model pin, turns and result are unknown; stdout and stderr are kept verbatim as the session's output" });
  if (!caps.cost) out.push({ guarantee: "cost", reason: "no cost reporting — the session's spend is not recorded" });
  return out;
}

/** A harness entry from `sdlc/config.yaml` as the console runs it (3.8). */
export interface ResolvedHarness {
  id: string;
  kind: HarnessSpec["kind"];
  /** `command` only. */
  command: string | null;
  args: string[];
  env: Record<string, string>;
  /** `claude-code` only: the executable override. */
  bin: string | null;
  /** Session kinds this entry serves; empty = every kind not claimed by a scoped entry. */
  jobs: HarnessJobKind[];
  capabilities: HarnessCapabilities;
  /** `degradedGuarantees(capabilities)`, resolved once so the Config view shows it without computing anything. */
  degraded: DegradedGuarantee[];
}

export function resolveHarness(spec: HarnessSpec): ResolvedHarness {
  if (spec.kind === "claude-code") {
    return { id: CLAUDE_CODE_HARNESS_ID, kind: "claude-code", command: null, args: [], env: {}, bin: spec.bin ?? null, jobs: spec.jobs ?? [], capabilities: CLAUDE_CODE_CAPABILITIES, degraded: degradedGuarantees(CLAUDE_CODE_CAPABILITIES) };
  }
  return { id: spec.id ?? "command", kind: "command", command: spec.command, args: spec.args ?? [], env: spec.env ?? {}, bin: null, jobs: spec.jobs ?? [], capabilities: COMMAND_HARNESS_CAPABILITIES, degraded: degradedGuarantees(COMMAND_HARNESS_CAPABILITIES) };
}

export const DEFAULT_HARNESS: ResolvedHarness = resolveHarness({ kind: "claude-code" });

/** The harness a session kind runs through: the first entry scoped to the kind, else the first unscoped entry, else Claude Code. */
export function harnessFor(harnesses: readonly ResolvedHarness[], kind: HarnessJobKind): ResolvedHarness {
  return harnesses.find((h) => h.jobs.includes(kind)) ?? harnesses.find((h) => h.jobs.length === 0) ?? DEFAULT_HARNESS;
}

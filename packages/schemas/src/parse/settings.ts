import type { Diagnostic } from "../validate.js";
import { parseJsonValue } from "./json.js";
import { error, fail, finish, isRecord, warning, type ParseResult } from "./result.js";

export type HookPhase = "edit" | "command" | "commit" | "stop" | "pre-deploy" | "other";
export type HookAction = "block" | "ask" | "allow";
export type HookScope = "managed" | "team";

/** One row of the Config → Hooks table (blueprint §5.14). */
export interface HookRow {
  name: string;
  phase: HookPhase;
  action: HookAction;
  scope: HookScope;
  matcher: string;
  script: string;
  description: string;
  warnings: string[];
  /** Origin inside settings.json: a hook entry or a permission rule. */
  source: "hooks" | "permissions";
}

export interface ParsedSettings {
  hooks: HookRow[];
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  /** Raw hook event names present, for display. */
  events: string[];
}

const EDIT_TOOLS = /\b(Edit|Write|MultiEdit|NotebookEdit)\b/;
const COMMAND_TOOLS = /\bBash\b/;

function phaseFor(event: string, matcher: string): HookPhase {
  if (event === "Stop" || event === "SubagentStop") return "stop";
  if (event === "PreToolUse" || event === "PostToolUse") {
    if (/git\s+commit|commit/i.test(matcher)) return "commit";
    if (EDIT_TOOLS.test(matcher)) return "edit";
    if (COMMAND_TOOLS.test(matcher) || matcher === "" || matcher === "*") return "command";
  }
  return "other";
}

/** `sdlc hook plan-sync` → plan-sync; `.claude/hooks/test-freeze.sh` → test-freeze. */
export function hookNameFromCommand(command: string): string {
  const viaCli = /sdlc\s+hook\s+([a-z0-9-]+)/i.exec(command);
  if (viaCli?.[1]) return viaCli[1];
  const script = /([A-Za-z0-9_-]+)\.(?:sh|mjs|js|ts)\b/.exec(command);
  if (script?.[1]) return script[1];
  return command.trim().split(/\s+/)[0] ?? command;
}

const KNOWN_PHASE: Record<string, HookPhase> = {
  "plan-sync": "commit",
  "test-freeze": "edit",
  "verify-before-done": "stop",
  "production-gate": "pre-deploy",
};

const KNOWN_DESCRIPTION: Record<string, string> = {
  "plan-sync": "commit files must be listed in plan.md or plan.md must change in the same commit",
  "test-freeze": "no edits under test globs while a repro test is committed",
  "verify-before-done": "session may only finish when the last round is green with output",
  "production-gate": "production deploy needs a human release authorization",
};

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Parse `.claude/settings.json` into hook rows. Command hooks are `block`
 * (exit 2 blocks); `permissions.ask/deny/allow` become `ask`/`block`/`allow`
 * rows so the hook lint sees approval prompts inside build sessions.
 */
export function parseSettings(text: string, path: string, scope: HookScope = "team"): ParseResult<ParsedSettings> {
  const raw = parseJsonValue(text, path);
  if (!raw.ok) return fail(raw.diagnostics);
  if (!isRecord(raw.value)) return fail([error(path, "settings.shape", "settings.json must be an object")]);
  const diagnostics: Diagnostic[] = [];
  const rows: HookRow[] = [];
  const events: string[] = [];

  const hooks = raw.value["hooks"];
  if (hooks !== undefined && !isRecord(hooks)) {
    diagnostics.push(error(path, "settings.hooks.shape", '"hooks" must be an object keyed by event'));
  } else if (isRecord(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      events.push(event);
      if (!Array.isArray(groups)) {
        diagnostics.push(error(path, "settings.hooks.shape", `hooks.${event} must be an array`));
        continue;
      }
      for (const group of groups) {
        if (!isRecord(group)) continue;
        const matcher = typeof group["matcher"] === "string" ? group["matcher"] : "";
        const entries = Array.isArray(group["hooks"]) ? group["hooks"] : [];
        for (const entry of entries) {
          if (!isRecord(entry) || typeof entry["command"] !== "string") {
            diagnostics.push(error(path, "settings.hooks.entry", `hooks.${event} entry needs a "command"`));
            continue;
          }
          const command = entry["command"];
          const name = hookNameFromCommand(command);
          const phase = KNOWN_PHASE[name] ?? phaseFor(event, matcher);
          const warnings: string[] = [];
          if (phase === "other") warnings.push(`unrecognised hook event ${event}`);
          rows.push({
            name,
            phase,
            action: "block",
            scope,
            matcher: matcher === "" ? `${event}` : `${event}:${matcher}`,
            script: command,
            description: KNOWN_DESCRIPTION[name] ?? "",
            warnings,
            source: "hooks",
          });
        }
      }
    }
  }

  const perms = isRecord(raw.value["permissions"]) ? raw.value["permissions"] : {};
  const permissions = {
    allow: stringList(perms["allow"]),
    ask: stringList(perms["ask"]),
    deny: stringList(perms["deny"]),
  };
  const permRow = (rule: string, action: HookAction): HookRow => {
    const phase: HookPhase = EDIT_TOOLS.test(rule) ? "edit" : COMMAND_TOOLS.test(rule) ? "command" : "other";
    const warnings: string[] = [];
    if (action === "ask" && (phase === "edit" || phase === "command")) {
      warnings.push("approval prompt in build — move to PR gate");
    }
    return { name: rule, phase, action, scope, matcher: rule, script: "", description: `permissions.${action}`, warnings, source: "permissions" };
  };
  rows.push(...permissions.deny.map((r) => permRow(r, "block")));
  rows.push(...permissions.ask.map((r) => permRow(r, "ask")));
  rows.push(...permissions.allow.map((r) => permRow(r, "allow")));

  for (const row of rows) {
    for (const w of row.warnings) diagnostics.push(warning(path, "settings.hook.lint", `${row.name}: ${w}`));
  }
  return finish({ hooks: rows, permissions, events }, diagnostics);
}

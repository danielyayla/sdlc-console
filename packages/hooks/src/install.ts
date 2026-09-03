import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOOK_NAMES } from "./run.js";

export interface InstallResult {
  created: string[];
  skipped: string[];
  /** Printed when settings.json already exists and must be edited by its owners. */
  snippet: string | null;
}

export function settingsSnippet(): Record<string, unknown> {
  return {
    permissions: { allow: ["Bash(pnpm build)", "Bash(pnpm test)", "Bash(pnpm lint)", "Bash(git status)", "Bash(git diff *)", "Bash(git add *)", "Bash(git commit *)"], deny: ["Bash(git push *)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: ".claude/hooks/test-freeze.sh" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: ".claude/hooks/plan-sync.sh" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: ".claude/hooks/verify-before-done.sh" }] }],
    },
  };
}

function wrapper(name: string, binPath: string | null): string {
  const fallback = binPath ? `exec node "\${SDLC_BIN:-${binPath}}" hook ${name}` : `exec node "$SDLC_BIN" hook ${name}`;
  return `#!/usr/bin/env sh
# Installed by sdlc init. Thin wrapper: the decision lives in @sdlc/core (check.${name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}).
# Exit 2 blocks the action and the message reaches the agent; every decision is logged to the change ledger.
if command -v sdlc >/dev/null 2>&1; then exec sdlc hook ${name}; fi
${fallback}
`;
}

/** Create-only: never rewrites an existing wrapper or settings.json (the console never edits .claude/**). */
export function installHooks(root: string, binPath: string | null): InstallResult {
  const created: string[] = [];
  const skipped: string[] = [];
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  for (const name of HOOK_NAMES) {
    const rel = `.claude/hooks/${name}.sh`;
    const abs = join(root, rel);
    if (existsSync(abs)) {
      skipped.push(rel);
      continue;
    }
    writeFileSync(abs, wrapper(name, binPath), "utf8");
    chmodSync(abs, 0o755);
    created.push(rel);
  }
  const settings = join(root, ".claude", "settings.json");
  if (existsSync(settings)) {
    skipped.push(".claude/settings.json");
    return { created, skipped, snippet: JSON.stringify(settingsSnippet(), null, 2) };
  }
  writeFileSync(settings, `${JSON.stringify(settingsSnippet(), null, 2)}\n`, "utf8");
  created.push(".claude/settings.json");
  return { created, skipped, snippet: null };
}

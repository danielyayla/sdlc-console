import { parseFrontMatter } from "./frontmatter.js";
import { countWords, findSection, outline } from "./markdown.js";
import { finish, warning, type ParseResult } from "./result.js";

/** "Under one page" for CLAUDE.md, counted in words (decisions: 0.3). */
export const ONE_PAGE_WORDS = 600;

export type CommandName = "build" | "test" | "lint" | "visual" | "other";

export interface VerificationCommand {
  name: CommandName;
  label: string;
  cmd: string;
  healthyOutput: string | null;
  /** False when the command chains several steps (`&&`, `;`, `|`). */
  singleTarget: boolean;
  line: number;
}

/** Parsed "Verifying your work" block (blueprint §5.9). */
export interface VerificationContract {
  commands: VerificationCommand[];
  testGlobs: string[];
  visualTool: "mcp-browser" | "screenshot-cli" | null;
  maxLoopRounds: number;
}

export interface ParsedClaudeMd {
  wordCount: number;
  overOnePage: boolean;
  version: string | null;
  /** The "mistake twice → CLAUDE.md" style rule, when one is written down. */
  workingRule: string | null;
  /** Commands listed under a `## Commands` section, if any. */
  commands: VerificationCommand[];
  verification: VerificationContract | null;
  sectionNames: string[];
}

const NAME_MAP: Record<string, CommandName> = {
  build: "build",
  compile: "build",
  test: "test",
  tests: "test",
  lint: "lint",
  typecheck: "lint",
  visual: "visual",
  screenshot: "visual",
};

function commandName(label: string): CommandName {
  return NAME_MAP[label.trim().toLowerCase()] ?? "other";
}

function isSingleTarget(cmd: string): boolean {
  return !/(\s&&\s|\s\|\|\s|;\s|\s\|\s)/.test(cmd);
}

/** `- Build: \`pnpm build\` (must finish with no errors)` → command row. */
function parseCommandLine(raw: string, line: number): VerificationCommand | null {
  const m = /^\s*[-*+]\s+([A-Za-z][\w -]*?)\s*:\s*`([^`]+)`\s*(?:\(([^)]*)\))?/.exec(raw);
  if (!m?.[1] || !m[2]) return null;
  return {
    name: commandName(m[1]),
    label: m[1].trim(),
    cmd: m[2].trim(),
    healthyOutput: m[3]?.trim() ?? null,
    singleTarget: isSingleTarget(m[2]),
    line,
  };
}

function backticked(raw: string): string[] {
  return [...raw.matchAll(/`([^`]+)`/g)].map((x) => x[1] ?? "").filter((s) => s !== "");
}

/**
 * Parse `CLAUDE.md` read-only. Recognised lines inside `## Verifying your work`:
 *   - Build|Test|Lint|Visual: `cmd` (healthy output)
 *   - Test files: `glob`, `glob`
 *   - Max rounds: N
 * Anything else in the block is ignored.
 */
export function parseClaudeMd(text: string, path: string): ParseResult<ParsedClaudeMd> {
  const split = parseFrontMatter(text, path);
  const body = split.value?.body ?? text;
  const bodyLine = split.value?.bodyLine ?? 1;
  const diagnostics = [...split.diagnostics];
  const md = outline(body, bodyLine);
  const wordCount = countWords(body);
  const overOnePage = wordCount > ONE_PAGE_WORDS;
  if (overOnePage) {
    diagnostics.push(warning(path, "claude-md.over-one-page", `CLAUDE.md is ${wordCount} words; keep it under one page (${ONE_PAGE_WORDS})`));
  }

  const versionFm = split.value?.data["version"];
  const versionComment = /<!--\s*version:\s*([^\s]+)\s*-->/.exec(body)?.[1];
  const version = typeof versionFm === "string" || typeof versionFm === "number" ? String(versionFm) : (versionComment ?? null);

  const workingRule =
    body.split(/\r?\n/).map((l) => l.trim()).find((l) => /\b(twice|repeat(ed)? mistake|same mistake)\b/i.test(l))?.replace(/^[-*+]\s+/, "") ?? null;

  const commands: VerificationCommand[] = [];
  const commandsSection = findSection(md.sections, "Commands");
  if (commandsSection) {
    commandsSection.content.split(/\r?\n/).forEach((raw, i) => {
      const c = parseCommandLine(raw, commandsSection.line + 1 + i);
      if (c) commands.push(c);
    });
  }

  let verification: VerificationContract | null = null;
  const verify = findSection(md.sections, "Verifying your work");
  if (!verify) {
    diagnostics.push(warning(path, "claude-md.verification.missing", 'no "## Verifying your work" block — no feedback loop'));
  } else {
    const vCommands: VerificationCommand[] = [];
    const testGlobs: string[] = [];
    let visualTool: VerificationContract["visualTool"] = null;
    let maxLoopRounds = 5;
    verify.content.split(/\r?\n/).forEach((raw, i) => {
      const line = verify.line + 1 + i;
      const globs = /^\s*[-*+]\s+test (?:files|globs)\s*:/i.exec(raw);
      if (globs) {
        testGlobs.push(...backticked(raw));
        return;
      }
      const rounds = /^\s*[-*+]\s+max (?:loop )?rounds\s*:\s*(\d+)/i.exec(raw);
      if (rounds?.[1]) {
        maxLoopRounds = Number(rounds[1]);
        return;
      }
      const c = parseCommandLine(raw, line);
      if (!c) return;
      vCommands.push(c);
      if (c.name === "visual") visualTool = /mcp/i.test(c.cmd) ? "mcp-browser" : "screenshot-cli";
      if (!c.singleTarget) {
        diagnostics.push(warning(path, "claude-md.command.multi-step", `"${c.label}" chains several steps — wrap in one target`, line));
      }
    });
    if (vCommands.length === 0) {
      diagnostics.push(warning(path, "claude-md.verification.empty", '"Verifying your work" lists no commands', verify.line));
    }
    verification = { commands: vCommands, testGlobs, visualTool, maxLoopRounds };
  }

  return finish(
    {
      wordCount,
      overOnePage,
      version,
      workingRule,
      commands,
      verification,
      sectionNames: md.sections.map((s) => s.name),
    },
    diagnostics,
  );
}

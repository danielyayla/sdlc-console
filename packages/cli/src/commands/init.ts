import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identity as gitIdentity, installMergeUnion, isRepo, repoRoot } from "@sdlc/adapter-git";
import { installHooks } from "@sdlc/hooks";
import { stringifyYaml } from "@sdlc/schemas";
import { CliError, type Io } from "../io.js";
import { TEMPLATES } from "../templates.js";
import { WORKFLOW_FILES, detectWorkflow, evalsWorkflow, productionGateWorkflow, validateWorkflow, type InstallStep } from "../workflows.js";

export interface InitOptions {
  product?: string;
  intentHome?: string;
  /** Command the generated workflows run instead of `npx sdlc` (a team's own install, e.g. `node tools/sdlc/bin.js`). */
  sdlcBin?: string;
}

/** The Install step follows the lockfile present when init runs; none means no step (the team adds one if `bin` needs it). */
export function installFromLockfile(root: string): InstallStep {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "package-lock.json")) || existsSync(join(root, "npm-shrinkwrap.json"))) return "npm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return null;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  /** settings.json snippet when .claude/settings.json already existed. */
  hooksSnippet: string | null;
}

function binPath(): string | null {
  try {
    return fileURLToPath(new URL("../bin.js", import.meta.url));
  } catch {
    return null;
  }
}

/** FR-01: idempotent; never overwrites; prints what it created. */
export async function init(io: Io, opts: InitOptions): Promise<InitResult> {
  if (!(await isRepo(io.cwd))) throw new CliError(`${io.cwd} is not a git repository — run \`git init\` first`);
  const root = await repoRoot(io.cwd);
  const created: string[] = [];
  const skipped: string[] = [];
  const put = (rel: string, content: string) => {
    const abs = join(root, rel);
    if (existsSync(abs)) {
      skipped.push(rel);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    created.push(rel);
  };

  const who = await gitIdentity(root);
  const config: Record<string, unknown> = {
    schema: 1,
    defaultRole: "po",
    codeHost: "local",
    identities: [{ id: who?.id ?? "you@example.com", ...(who?.name ? { name: who.name } : {}), roles: ["po", "eng", "tech_lead"] }],
    thresholds: { autoFilesMax: 12, maxLoopRounds: 5, sessionCeiling: 4, suiteMinSize: 20 },
    records: { intent: "repo", spec: "repo", plan: "repo", evals: "repo", pr: "repo", incident: "repo" },
    evals: { mode: "continuous", threshold: 0.9 },
    eligibility: { coverage: "lenient" },
  };
  if (opts.product) config["products"] = [{ name: opts.product, path: "." }];
  if (opts.intentHome) config["intentHome"] = opts.intentHome;
  put("sdlc/config.yaml", stringifyYaml(config));
  for (const [name, body] of Object.entries(TEMPLATES)) put(`sdlc/templates/${name}.md`, body);
  for (const dir of ["sdlc/changes", "sdlc/loop/triage", "sdlc/security/findings", "sdlc/proposals", "evals/cases", "evals/runs"]) put(`${dir}/.gitkeep`, "");

  // CI: the eval suite as the config-change gate, and validation on every PR (create-only). The command and the
  // install step are the team's: `--sdlc-bin` names their install, the lockfile picks the package manager (3.0).
  const workflow = { install: installFromLockfile(root), ...(opts.sdlcBin ? { bin: opts.sdlcBin } : {}) };
  put(WORKFLOW_FILES.evals, evalsWorkflow(workflow));
  put(WORKFLOW_FILES.validate, validateWorkflow(workflow));
  put(WORKFLOW_FILES.detect, detectWorkflow(workflow));
  put(WORKFLOW_FILES.productionGate, productionGateWorkflow(workflow));

  if (installMergeUnion(root)) created.push(".gitattributes");
  else skipped.push(".gitattributes");

  const gi = join(root, ".gitignore");
  const existing = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!existing.split(/\r?\n/).some((l) => l.trim() === ".sdlc-state/")) {
    writeFileSync(gi, `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}.sdlc-state/\n`, "utf8");
    created.push(".gitignore (.sdlc-state/)");
  } else skipped.push(".gitignore");

  // .mcp.json so Claude Code finds the agent tools (create-only)
  const bin = binPath();
  put(".mcp.json", `${JSON.stringify({ mcpServers: { sdlc: bin ? { command: "node", args: [bin, "mcp"] } : { command: "sdlc", args: ["mcp"] } } }, null, 2)}\n`);

  // hook wrappers + settings.json, create-only (the console never edits .claude/**)
  const hooks = installHooks(root, binPath());
  created.push(...hooks.created);
  skipped.push(...hooks.skipped);
  return { created, skipped, hooksSnippet: hooks.snippet };
}

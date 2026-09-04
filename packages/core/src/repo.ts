import {
  parseAgent,
  parseArtifact,
  parseBands,
  parseClaudeMd,
  parseJson,
  parseJsonl,
  parsePlan,
  parseSettings,
  parseSkill,
  parseYaml,
  type Bands,
  type Change,
  type Config,
  type ConfigRef,
  type Deploy,
  type Diagnostic,
  type EvalCase,
  type EvalRun,
  type Event,
  type Finding,
  type ParsedAgent,
  type ParsedArtifact,
  type ParsedClaudeMd,
  type ParsedPlan,
  type ParsedSettings,
  type ParsedSkill,
  type PerChangeRun,
  type Pr,
  type Proposal,
  type ReproProof,
  type Round,
  type Tasks,
  type Triage,
  type VerificationContract,
} from "@sdlc/schemas";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { dedupeEvents, sortEvents } from "./events.js";
import { PATHS, configFingerprint } from "./fingerprint.js";
import { childDirs, filesUnder, readFile, type Tree } from "./tree.js";

export interface ChangeFiles {
  id: string;
  dir: string;
  change: Change | null;
  events: Event[];
  intent: ParsedArtifact<"intent"> | null;
  spec: ParsedArtifact<"spec"> | null;
  plan: ParsedPlan | null;
  incident: ParsedArtifact<"incident"> | null;
  tasks: Tasks | null;
  pr: Pr | null;
  deploy: Deploy | null;
  runs: PerChangeRun[];
  finalRound: Round | null;
  repro: ReproProof | null;
  /** Blob shas of artifact files present, by artifact file name. */
  shas: Partial<Record<"intent.md" | "spec.md" | "plan.md" | "pr.yaml" | "incident.md" | "change.yaml", string>>;
  present: { intent: boolean; spec: boolean; plan: boolean; evals: boolean; pr: boolean; incident: boolean };
  archivedCycles: number[];
  diagnostics: Diagnostic[];
}

export interface TriageFile {
  path: string;
  data: Triage;
  body: string;
}

export interface Repo {
  tree: Tree;
  config: ResolvedConfig;
  rawConfig: Config | null;
  claudeMd: ParsedClaudeMd | null;
  verification: VerificationContract | null;
  /** `REVIEW.md` (review policy) verbatim with its blob sha; parsed for the review job, never edited. */
  reviewPolicy: { sha: string; text: string } | null;
  settings: ParsedSettings | null;
  skills: ParsedSkill[];
  agents: ParsedAgent[];
  bands: Bands | null;
  fingerprint: ConfigRef;
  changes: Map<string, ChangeFiles>;
  triage: TriageFile[];
  findings: Finding[];
  proposals: Proposal[];
  evalCases: EvalCase[];
  evalRuns: EvalRun[];
  /** Repo-level diagnostics (config, CLAUDE.md, settings, …); change-level ones live on each ChangeFiles. */
  diagnostics: Diagnostic[];
}

const ARTIFACT_KINDS = ["intent", "spec", "incident"] as const;

function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

/** Load one change directory. Every file is parsed; failures become diagnostics. */
export function loadChange(tree: Tree, id: string): ChangeFiles {
  const dir = `${PATHS.changesDir}/${id}`;
  const diagnostics: Diagnostic[] = [];
  const at = (name: string) => `${dir}/${name}`;
  const text = (name: string) => readFile(tree, at(name))?.content;

  const files: ChangeFiles = {
    id,
    dir,
    change: null,
    events: [],
    intent: null,
    spec: null,
    plan: null,
    incident: null,
    tasks: null,
    pr: null,
    deploy: null,
    runs: [],
    finalRound: null,
    repro: null,
    shas: {},
    present: { intent: false, spec: false, plan: false, evals: false, pr: false, incident: false },
    archivedCycles: [],
    diagnostics,
  };

  const changeText = text("change.yaml");
  if (changeText === undefined) {
    diagnostics.push({ path: at("change.yaml"), severity: "error", rule: "change.missing", message: "change.yaml is missing" });
  } else {
    const r = parseYaml("change", changeText, at("change.yaml"));
    diagnostics.push(...r.diagnostics);
    files.change = r.value;
    setSha(files, "change.yaml", readFile(tree, at("change.yaml"))?.sha);
    if (r.value && r.value.id !== id) {
      diagnostics.push({ path: at("change.yaml"), severity: "error", rule: "change.id.mismatch", message: `change.yaml id ${r.value.id} does not match directory ${id}` });
    }
  }

  const logText = text("log.jsonl");
  if (logText !== undefined) {
    const r = parseJsonl(logText, at("log.jsonl"));
    diagnostics.push(...r.diagnostics);
    // keep good lines even when some are bad: re-parse leniently
    files.events = sortEvents(dedupeEvents(r.value ?? lenientEvents(logText, at("log.jsonl"))));
  }

  for (const kind of ARTIFACT_KINDS) {
    const name = `${kind}.md` as const;
    const t = text(name);
    if (t === undefined) continue;
    files.present[kind] = true;
    setSha(files, name, readFile(tree, at(name))?.sha);
    const r = parseArtifact(kind, t, at(name));
    diagnostics.push(...r.diagnostics);
    if (kind === "intent") files.intent = r.value as ParsedArtifact<"intent"> | null;
    if (kind === "spec") files.spec = r.value as ParsedArtifact<"spec"> | null;
    if (kind === "incident") files.incident = r.value as ParsedArtifact<"incident"> | null;
  }

  const planText = text("plan.md");
  if (planText !== undefined) {
    files.present.plan = true;
    setSha(files, "plan.md", readFile(tree, at("plan.md"))?.sha);
    const r = parsePlan(planText, at("plan.md"));
    diagnostics.push(...r.diagnostics);
    files.plan = r.value;
  }

  const tasksText = text("tasks.yaml");
  if (tasksText !== undefined) {
    const r = parseYaml("tasks", tasksText, at("tasks.yaml"));
    diagnostics.push(...r.diagnostics);
    files.tasks = r.value;
  }

  const prText = text("pr.yaml");
  if (prText !== undefined) {
    files.present.pr = true;
    setSha(files, "pr.yaml", readFile(tree, at("pr.yaml"))?.sha);
    const r = parseYaml("pr", prText, at("pr.yaml"));
    diagnostics.push(...r.diagnostics);
    files.pr = r.value;
  }

  const deployText = text("deploy.yaml");
  if (deployText !== undefined) {
    const r = parseYaml("deploy", deployText, at("deploy.yaml"));
    diagnostics.push(...r.diagnostics);
    files.deploy = r.value;
  }

  for (const path of filesUnder(tree, at("evals"))) {
    const name = path.slice(at("evals").length + 1);
    const content = readFile(tree, path)?.content ?? "";
    if (/^run-\d+\.json$/.test(name)) {
      const r = parseJson("per-change-run", content, path);
      diagnostics.push(...r.diagnostics);
      if (r.value) files.runs.push(r.value);
      files.present.evals = true;
    } else if (name === "final-round.json") {
      const r = parseJson("round", content, path);
      diagnostics.push(...r.diagnostics);
      files.finalRound = r.value;
      files.present.evals = true;
    } else if (name === "repro.json") {
      const r = parseJson("repro-proof", content, path);
      diagnostics.push(...r.diagnostics);
      files.repro = r.value;
    }
  }
  files.runs.sort((a, b) => a.n - b.n);

  files.archivedCycles = childDirs(tree, at("cycles"))
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

  return files;
}

function setSha(files: ChangeFiles, name: keyof ChangeFiles["shas"], sha: string | undefined): void {
  if (sha !== undefined) files.shas[name] = sha;
}

function lenientEvents(text: string, path: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const r = parseJsonl(line, path);
    if (r.value) out.push(...r.value);
  }
  return out;
}

/**
 * Parse everything the console reads from one tree. Pure: no I/O, no throw.
 * Missing optional files are simply absent; malformed ones carry diagnostics.
 */
export function loadRepo(tree: Tree): Repo {
  const diagnostics: Diagnostic[] = [];
  const read = (path: string) => readFile(tree, path)?.content;

  let rawConfig: Config | null = null;
  const configText = read(PATHS.config);
  if (configText === undefined) {
    diagnostics.push({ path: PATHS.config, severity: "warning", rule: "config.missing", message: "sdlc/config.yaml is missing; defaults apply" });
  } else {
    const r = parseYaml("config", configText, PATHS.config);
    diagnostics.push(...r.diagnostics);
    rawConfig = r.value;
  }
  const config = resolveConfig(rawConfig);

  let claudeMd: ParsedClaudeMd | null = null;
  const claudeText = read(PATHS.claudeMd);
  if (claudeText === undefined) {
    diagnostics.push({ path: PATHS.claudeMd, severity: "warning", rule: "claude-md.missing", message: "CLAUDE.md is missing — no feedback loop" });
  } else {
    const r = parseClaudeMd(claudeText, PATHS.claudeMd);
    diagnostics.push(...r.diagnostics);
    claudeMd = r.value;
  }

  let settings: ParsedSettings | null = null;
  const settingsText = read(PATHS.settings);
  if (settingsText !== undefined) {
    const r = parseSettings(settingsText, PATHS.settings);
    diagnostics.push(...r.diagnostics);
    settings = r.value;
  }

  const skills: ParsedSkill[] = [];
  for (const name of childDirs(tree, PATHS.skillsDir)) {
    const path = `${PATHS.skillsDir}/${name}/SKILL.md`;
    const t = read(path);
    if (t === undefined) continue;
    const r = parseSkill(t, path, name);
    diagnostics.push(...r.diagnostics);
    if (r.value) skills.push(r.value);
  }

  const agents: ParsedAgent[] = [];
  for (const path of filesUnder(tree, PATHS.agentsDir).filter((p) => p.endsWith(".md"))) {
    const r = parseAgent(read(path) ?? "", path, stem(path));
    diagnostics.push(...r.diagnostics);
    if (r.value) agents.push(r.value);
  }

  let bands: Bands | null = null;
  const bandsText = read(PATHS.bands);
  if (bandsText !== undefined) {
    const r = parseBands(bandsText, PATHS.bands);
    diagnostics.push(...r.diagnostics);
    bands = r.value;
  }

  const changes = new Map<string, ChangeFiles>();
  for (const id of childDirs(tree, PATHS.changesDir)) {
    changes.set(id, loadChange(tree, id));
  }

  const triage: TriageFile[] = [];
  for (const path of filesUnder(tree, PATHS.triageDir).filter((p) => p.endsWith(".md"))) {
    const r = parseYamlFrontMatter(read(path) ?? "", path);
    diagnostics.push(...r.diagnostics);
    if (r.value) triage.push({ path, data: r.value.data, body: r.value.body });
  }

  const findings: Finding[] = [];
  for (const path of filesUnder(tree, PATHS.findingsDir).filter((p) => /\.ya?ml$/.test(p))) {
    const r = parseYaml("finding", read(path) ?? "", path);
    diagnostics.push(...r.diagnostics);
    if (r.value) findings.push(r.value);
  }

  const proposals: Proposal[] = [];
  for (const path of filesUnder(tree, PATHS.proposalsDir).filter((p) => /\.ya?ml$/.test(p))) {
    const r = parseYaml("proposal", read(path) ?? "", path);
    diagnostics.push(...r.diagnostics);
    if (r.value) proposals.push(r.value);
  }

  const evalCases: EvalCase[] = [];
  for (const path of filesUnder(tree, PATHS.evalCasesDir).filter((p) => p.endsWith(".json"))) {
    const r = parseJson("eval-case", read(path) ?? "", path);
    diagnostics.push(...r.diagnostics);
    if (r.value) evalCases.push(r.value);
  }

  const evalRuns: EvalRun[] = [];
  for (const path of filesUnder(tree, PATHS.evalRunsDir).filter((p) => p.endsWith(".json"))) {
    const r = parseJson("eval-run", read(path) ?? "", path);
    diagnostics.push(...r.diagnostics);
    if (r.value) evalRuns.push(r.value);
  }
  evalRuns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return {
    tree,
    config,
    rawConfig,
    claudeMd,
    verification: claudeMd?.verification ?? null,
    reviewPolicy: (() => {
      const f = readFile(tree, PATHS.reviewMd);
      return f ? { sha: f.sha, text: f.content } : null;
    })(),
    settings,
    skills,
    agents,
    bands,
    fingerprint: configFingerprint(tree),
    changes,
    triage,
    findings,
    proposals,
    evalCases,
    evalRuns,
    diagnostics,
  };
}

function parseYamlFrontMatter(text: string, path: string): { value: { data: Triage; body: string } | null; diagnostics: Diagnostic[] } {
  // Triage items are markdown with front-matter; validate the front-matter as `triage`.
  const split = splitFrontMatter(text);
  if (split === null) {
    return { value: null, diagnostics: [{ path, severity: "error", rule: "triage.frontmatter.missing", message: "triage item has no front-matter" }] };
  }
  const r = parseYaml("triage", split.yaml, path);
  return { value: r.value ? { data: r.value, body: split.body } : null, diagnostics: r.diagnostics };
}

function splitFrontMatter(text: string): { yaml: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m || m[1] === undefined) return null;
  return { yaml: m[1], body: m[2] ?? "" };
}

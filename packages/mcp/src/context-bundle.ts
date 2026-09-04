import { createHash } from "node:crypto";
import { PATHS, filesUnder, readFile, type ChangeView, type Repo } from "@sdlc/core";

export type JobKind = "intent-session" | "design-pass" | "plan-session" | "build-session" | "review" | "diagnose" | "claude-md-proposal";

export interface BundleFile {
  path: string;
  sha: string;
}

/** Per-stage context bundle (blueprint §8.3) with a hash for `context_manifest`. */
export interface ContextBundle {
  changeId: string;
  cycle: number;
  stage: number;
  job: JobKind;
  files: BundleFile[];
  promptRef: string;
  allowedTools: string[];
  skills: { name: string; version: string }[];
  claudeMdSha: string;
  hooksSha: string;
  model: string;
  /** sha256 over everything above; written into the produced artifact's front-matter. */
  manifest: string;
  /** What the agent is expected to produce. */
  output: string;
}

/** The proposal job reads the cluster and CLAUDE.md and files one line through the tool; it is stage-independent (FR-43). */
export const PROPOSAL_JOB = { job: "claude-md-proposal" as JobKind, promptRef: "prompts/claude-md-proposal@1", allowedTools: ["Read", "Grep", "Glob", "mcp__sdlc__get_change", "mcp__sdlc__propose_claude_md_line", "mcp__sdlc__log_note"], output: "one CLAUDE.md line via propose_claude_md_line; never an edit to CLAUDE.md" };

const JOBS: Record<number, { job: JobKind; promptRef: string; allowedTools: string[]; output: string }> = {
  1: { job: "intent-session", promptRef: "prompts/intent@1", allowedTools: ["Read", "Grep", "mcp__sdlc__propose_artifact", "mcp__sdlc__log_note", "mcp__sdlc__request_input"], output: "intent.md (index 0) via propose_artifact" },
  2: { job: "design-pass", promptRef: "prompts/design-pass@1", allowedTools: ["Read", "Grep", "Skill", "mcp__sdlc__propose_artifact", "mcp__sdlc__log_note"], output: "spec.md (index 1) via propose_artifact with flagged concerns" },
  3: { job: "plan-session", promptRef: "prompts/plan-session@1", allowedTools: ["Read", "Grep", "Glob", "mcp__sdlc__submit_plan_revision", "mcp__sdlc__log_note", "mcp__sdlc__request_input"], output: "plan.md via submit_plan_revision (final=true opens gate 3)" },
  4: { job: "build-session", promptRef: "prompts/build-session@1", allowedTools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "mcp__sdlc__report_repro", "mcp__sdlc__report_round", "mcp__sdlc__report_done", "mcp__sdlc__request_input", "mcp__sdlc__log_note"], output: "commits on the task branch; a fix reports its failing test via report_repro first; rounds via report_round; report_done only when green" },
  5: { job: "review", promptRef: "prompts/review@1", allowedTools: ["Read", "Grep", "Glob", "mcp__sdlc__report_finding", "mcp__sdlc__log_note"], output: "review findings via report_finding, ranked by severity; never approve or merge" },
  6: { job: "diagnose", promptRef: "prompts/diagnose@1", allowedTools: ["Read", "Grep", "mcp__sdlc__propose_artifact", "mcp__sdlc__log_note"], output: "incident.md (index 5) via propose_artifact" },
};

export function buildContext(repo: Repo, view: ChangeView, job?: typeof PROPOSAL_JOB): ContextBundle {
  const dir = `sdlc/changes/${view.id}`;
  const add = (files: BundleFile[], path: string) => {
    const f = readFile(repo.tree, path);
    if (f) files.push({ path, sha: f.sha });
  };
  const files: BundleFile[] = [];
  for (const name of ["intent.md", "spec.md", "plan.md", "incident.md", "change.yaml", "tasks.yaml"]) add(files, `${dir}/${name}`);
  for (const path of filesUnder(repo.tree, `${dir}/design`)) add(files, path);
  add(files, PATHS.claudeMd);
  add(files, PATHS.reviewMd);
  for (const s of repo.skills) add(files, `${PATHS.skillsDir}/${s.name}/SKILL.md`);
  for (const t of ["intent", "spec", "plan", "incident"]) add(files, `sdlc/templates/${t}.md`);
  const spec = job ?? JOBS[view.stage] ?? JOBS[1];
  if (!spec) throw new Error("no job spec");
  const fp = repo.fingerprint;
  const payload = { changeId: view.id, cycle: view.cycle, stage: view.stage, job: spec.job, files, promptRef: spec.promptRef, allowedTools: spec.allowedTools, skills: fp.skills, claudeMdSha: fp.claudeMdSha, hooksSha: fp.hooksSha, model: fp.model };
  const manifest = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  return { ...payload, manifest, output: spec.output };
}

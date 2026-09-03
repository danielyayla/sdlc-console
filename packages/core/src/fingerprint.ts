import type { ConfigRef } from "@sdlc/schemas";
import { childDirs, readFile, ZERO_SHA, type Tree } from "./tree.js";

export const PATHS = {
  claudeMd: "CLAUDE.md",
  reviewMd: "REVIEW.md",
  bands: "bands.yaml",
  settings: ".claude/settings.json",
  skillsDir: ".claude/skills",
  agentsDir: ".claude/agents",
  config: "sdlc/config.yaml",
  changesDir: "sdlc/changes",
  triageDir: "sdlc/loop/triage",
  findingsDir: "sdlc/security/findings",
  proposalsDir: "sdlc/proposals",
  evalCasesDir: "evals/cases",
  evalRunsDir: "evals/runs",
} as const;

/** Model pins are not in the tree; runs record what they used. */
export const UNPINNED_MODEL = "unpinned";

/** The config fingerprint a run must match to count for stage 4 (§5.10, §4 Stage 04). */
export function configFingerprint(tree: Tree): ConfigRef {
  const skills = childDirs(tree, PATHS.skillsDir).map((name) => ({
    name,
    version: readFile(tree, `${PATHS.skillsDir}/${name}/SKILL.md`)?.sha ?? ZERO_SHA,
  }));
  return {
    claudeMdSha: readFile(tree, PATHS.claudeMd)?.sha ?? ZERO_SHA,
    hooksSha: readFile(tree, PATHS.settings)?.sha ?? ZERO_SHA,
    skills,
    model: UNPINNED_MODEL,
  };
}

/** Same CLAUDE.md, hooks and skill versions; the model is recorded, not matched. */
export function fingerprintMatches(a: ConfigRef, b: ConfigRef): boolean {
  if (a.claudeMdSha !== b.claudeMdSha || a.hooksSha !== b.hooksSha) return false;
  if (a.skills.length !== b.skills.length) return false;
  const bySkill = new Map(b.skills.map((s) => [s.name, s.version]));
  return a.skills.every((s) => bySkill.get(s.name) === s.version);
}

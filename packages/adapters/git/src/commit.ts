import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { logPath, type WritePlan } from "@sdlc/core";
import { stringifyJsonl } from "@sdlc/schemas";
import { git, gitRaw, type GitIdentity } from "./git.js";

export interface CommitOptions {
  /** Author and committer of the decision commit (the acting human, or the agent/system identity). */
  identity: GitIdentity;
  /** Refuse unless the working tree is on this branch. */
  branch?: string;
  /** Override the commit timestamp (ISO); defaults to now. */
  date?: string;
}

function envFor(who: GitIdentity, date?: string): Record<string, string> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.id,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.id,
  };
  if (date) {
    env["GIT_AUTHOR_DATE"] = date;
    env["GIT_COMMITTER_DATE"] = date;
  }
  return env;
}

export function formatMessage(plan: Pick<WritePlan, "commitMessage" | "trailers">): string {
  const trailers = Object.entries(plan.trailers).map(([k, v]) => `${k}: ${v}`);
  return trailers.length > 0 ? `${plan.commitMessage}\n\n${trailers.join("\n")}\n` : `${plan.commitMessage}\n`;
}

/**
 * Apply a write-plan to the working tree of `dir` and commit exactly those
 * paths (deletes, writes, ledger appends) in one commit. Other dirty files are
 * left untouched and unstaged. Returns the commit sha.
 */
export async function commitWritePlan(dir: string, plan: WritePlan, opts: CommitOptions): Promise<string> {
  if (opts.branch) {
    const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== opts.branch) throw new Error(`working tree is on ${current}, expected ${opts.branch}`);
  }
  const touched = new Set<string>();
  for (const f of plan.files.filter((x) => x.content === null)) {
    const abs = join(dir, f.path);
    if (existsSync(abs)) rmSync(abs);
    touched.add(f.path);
  }
  for (const f of plan.files.filter((x) => x.content !== null)) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content ?? "", "utf8");
    touched.add(f.path);
  }
  const byChange = new Map<string, WritePlan["events"][number]["event"][]>();
  for (const e of plan.events) byChange.set(e.changeId, [...(byChange.get(e.changeId) ?? []), e.event]);
  for (const [changeId, events] of byChange) {
    const rel = logPath(changeId);
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, stringifyJsonl(events), "utf8");
    touched.add(rel);
  }
  if (touched.size === 0) throw new Error("write-plan touches no files");
  await git(dir, ["add", "-A", "--", ...touched]);
  const env = envFor(opts.identity, opts.date);
  await git(dir, ["commit", "-q", "--only", "-F", "-", "--", ...touched], { input: formatMessage(plan), env });
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Files changed between two refs (or a ref and the working tree when `to` is omitted). */
export async function diffFiles(dir: string, from: string, to?: string): Promise<string[]> {
  const args = to ? ["diff", "--name-only", "-z", from, to] : ["diff", "--name-only", "-z", from];
  const out = await git(dir, args);
  return out.split("\0").filter(Boolean);
}

export async function stagedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ["diff", "--cached", "--name-only", "-z"]);
  return out.split("\0").filter(Boolean);
}

export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

/** Commits touching a path, newest first (artifact history, rework metrics). */
export async function fileHistory(dir: string, path: string, ref = "HEAD"): Promise<CommitInfo[]> {
  const r = await gitRaw(dir, ["log", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s", ref, "--", path]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", author = "", email = "", date = "", subject = ""] = line.split("\x1f");
      return { sha, author, email, date, subject };
    });
}

/** Trailers of a commit as a map (`SDLC-Event`, `SDLC-Actor`). */
export async function commitTrailers(dir: string, sha: string): Promise<Record<string, string>> {
  const body = await git(dir, ["show", "-s", "--format=%B", sha]);
  const parsed = await git(dir, ["interpret-trailers", "--parse"], { input: body });
  const out: Record<string, string> = {};
  for (const line of parsed.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

/** Merge a branch into the current one with a merge commit (gate 5, local mode). Returns the merge sha. */
export async function mergeBranch(dir: string, branch: string, message: string, who: GitIdentity): Promise<string> {
  await git(dir, ["merge", "--no-ff", "--no-edit", "-m", message, branch], { env: envFor(who) });
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

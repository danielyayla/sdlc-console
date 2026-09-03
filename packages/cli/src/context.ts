import { blobSha, commitWritePlan, defaultBranch, identity as gitIdentity, isRepo, newUlid, readTree, readWorkingTree, repoRoot, type GitIdentity } from "@sdlc/adapter-git";
import { deriveChange, loadRepo, validateWritePlan, type ChangeView, type Repo, type TransitionContext, type Tree, type WritePlan } from "@sdlc/core";
import { CliError, type Io } from "./io.js";

export interface CliContext {
  io: Io;
  root: string;
  json: boolean;
}

export async function repoContext(io: Io, json: boolean): Promise<CliContext> {
  if (!(await isRepo(io.cwd))) throw new CliError(`${io.cwd} is not a git repository — run \`git init\` first`);
  return { io, root: await repoRoot(io.cwd), json };
}

/** Mutating commands refuse when the launcher marks the process as an agent (§9.1). */
export function assertHuman(io: Io): void {
  if ((io.env["SDLC_ACTOR_TYPE"] ?? "").toLowerCase() === "agent") {
    throw new CliError("refused: SDLC_ACTOR_TYPE=agent — gate decisions and change mutations are human-only. Use the MCP tools to propose artifacts.", 2);
  }
}

/** Acting identity: `SDLC_IDENTITY` (email) overrides git config; name from git when available. */
export async function actingIdentity(ctx: CliContext): Promise<GitIdentity> {
  const fromGit = await gitIdentity(ctx.root);
  const override = ctx.io.env["SDLC_IDENTITY"];
  if (override && override.trim() !== "") return { id: override.trim(), name: fromGit?.name ?? override.trim() };
  if (!fromGit) throw new CliError("no git identity — set user.email (or SDLC_IDENTITY) before acting on a change");
  return fromGit;
}

export interface Loaded {
  tree: Tree;
  repo: Repo;
}

export async function loadCommitted(ctx: CliContext, ref = "HEAD"): Promise<Loaded> {
  const tree = await readTree(ctx.root, ref);
  return { tree, repo: loadRepo(tree) };
}

export function loadWorking(ctx: CliContext): Loaded {
  const tree = readWorkingTree(ctx.root);
  return { tree, repo: loadRepo(tree) };
}

export function viewOf(repo: Repo, id: string): ChangeView {
  const files = repo.changes.get(id);
  if (!files) throw new CliError(`${id} not found under sdlc/changes/`);
  return deriveChange(repo, files);
}

export function transitionContext(who: GitIdentity, extra: Partial<TransitionContext> = {}): TransitionContext {
  return { now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), newId: newUlid, actor: who, blobSha, ...extra };
}

/** Validate then commit a plan on the current branch. */
export async function commitPlan(ctx: CliContext, repo: Repo, plan: WritePlan, who: GitIdentity): Promise<string> {
  const report = validateWritePlan(repo, plan);
  if (report.blocking) {
    throw new CliError("write-plan rejected by validation", 1, report.diagnostics.filter((d) => d.blocking));
  }
  return commitWritePlan(ctx.root, plan, { identity: who });
}

export async function baseBranch(ctx: CliContext, repo: Repo): Promise<string> {
  return repo.rawConfig?.defaultBranch ?? (await defaultBranch(ctx.root));
}

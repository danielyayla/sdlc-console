import { resolve } from "node:path";
import { blobSha, commitWritePlan, defaultBranch, homeFor, identity as gitIdentity, isRepo, newUlid, readTree, readWorkingTree, type GitIdentity } from "@sdlc/adapter-git";
import { deriveChange, loadRepo, validateWritePlan, type ChangeView, type Repo, type TransitionContext, type Tree, type WritePlan } from "@sdlc/core";
import { CliError, type Io } from "./io.js";

export interface CliContext {
  io: Io;
  /** The SDLC home the command works in: the repository root, or a product's directory in a monorepo (3.2). */
  root: string;
  /** Repository top level. */
  repoRoot: string;
  json: boolean;
}

/**
 * Where a command works: the nearest `sdlc/` home from the working directory
 * (`SDLC_HOME` when set). `--product <name>` (or `SDLC_PRODUCT`) picks one of
 * the home's `config.products[]` instead; a home that lists several products
 * refuses to guess when the working directory is not inside one of them.
 */
export async function repoContext(io: Io, json: boolean, product?: string): Promise<CliContext> {
  if (!(await isRepo(io.cwd))) throw new CliError(`${io.cwd} is not a git repository — run \`git init\` first`);
  const found = await homeFor(io.cwd, io.env);
  const wanted = product ?? io.env["SDLC_PRODUCT"];
  const tree = await readTree(found.home, "HEAD").catch(() => null);
  const products = tree ? (loadRepo(tree).rawConfig?.products ?? []) : [];
  if (wanted) {
    const hit = products.find((p) => p.name === wanted);
    if (!hit) throw new CliError(products.length === 0 ? `no products are configured in ${found.home}/sdlc/config.yaml; --product ${wanted} names none` : `no product named ${wanted}; ${found.home} lists ${products.map((p) => p.name).join(", ")}`);
    return { io, root: resolve(found.home, hit.path), repoRoot: found.root, json };
  }
  const nested = products.filter((p) => resolve(found.home, p.path) !== found.home);
  if (nested.length > 0 && products.length > 1 && !io.env["SDLC_HOME"]) {
    throw new CliError(`${found.home} lists ${products.length} products (${products.map((p) => p.name).join(", ")}); pass --product <name>, set SDLC_PRODUCT, or run the command inside the product's directory`);
  }
  return { io, root: found.home, repoRoot: found.root, json };
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

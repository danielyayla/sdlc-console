import { blobSha, commitWritePlan, GitError, headSha, newUlid, readTreeWithBranches, type ArtifactBranch, type GitIdentity } from "@sdlc/adapter-git";
import { loadRepo, rolesOf, validateWritePlan, type Repo, type TransitionContext, type TransitionResult, type Tree } from "@sdlc/core";
import type { Diagnostic } from "@sdlc/schemas";
import { buildSnapshot, type Identity, type SessionRecord, type Snapshot } from "./snapshot.js";

export class ActionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 502,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
    readonly retryable = false,
  ) {
    super(message);
  }
}

const ROLE_RULES = /(not-owner|not-engineer|not-po|gate\.via)/;

export interface StoreOptions {
  root: string;
  identity: GitIdentity;
  ref?: string;
  /** Session provider; receives the current repo so records can be enriched from the ledger. */
  sessions?: (repo: Repo | null) => SessionRecord[];
  now?: () => Date;
}

/**
 * One derived snapshot per HEAD, recomputed on demand; actions run a core
 * transition, validate the write-plan, commit it through the git adapter and
 * refresh. Nothing lifecycle-related is kept in memory beyond the snapshot.
 */
export class StateStore {
  private tree: Tree | null = null;
  private repo: Repo | null = null;
  private snapshot: Snapshot | null = null;
  private branches: ArtifactBranch[] = [];
  private revision = 0;
  private lastHead: string | null = null;
  private readonly listeners = new Set<(s: Snapshot) => void>();
  private refreshing: Promise<Snapshot> | null = null;

  constructor(private readonly opts: StoreOptions) {}

  get root(): string {
    return this.opts.root;
  }

  get who(): GitIdentity {
    return this.opts.identity;
  }

  get current(): Snapshot | null {
    return this.snapshot;
  }

  get currentRepo(): Repo | null {
    return this.repo;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  identity(): Identity {
    const roles = this.repo ? rolesOf(this.repo.config, this.opts.identity.id) : [];
    return { id: this.opts.identity.id, name: this.opts.identity.name, roles };
  }

  /** Re-read HEAD and re-derive. Coalesces concurrent calls. */
  refresh(force = false): Promise<Snapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const head = await headSha(this.opts.root, this.opts.ref ?? "HEAD");
        // unmerged artifact branches (drafts in review) are part of what the console shows
        const read = await readTreeWithBranches(this.opts.root, this.opts.ref ?? "HEAD");
        const key = `${head}|${read.branches.map((b) => `${b.branch}@${b.head}`).join(",")}`;
        if (!force && key === this.lastHead && this.snapshot) return this.snapshot;
        this.tree = read.tree;
        this.branches = read.branches;
        this.repo = loadRepo(this.tree);
        this.lastHead = key;
        this.revision += 1;
        this.snapshot = { ...buildSnapshot(this.repo, this.identity(), this.opts.sessions?.(this.repo) ?? [], this.revision, this.opts.now?.() ?? new Date()), branches: this.branches };
        for (const fn of this.listeners) fn(this.snapshot);
        return this.snapshot;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Something outside the tree changed (sessions): rebuild the snapshot without re-reading git. */
  rebuild(): Snapshot {
    if (!this.repo) throw new Error("store not loaded");
    this.revision += 1;
    this.snapshot = { ...buildSnapshot(this.repo, this.identity(), this.opts.sessions?.(this.repo) ?? [], this.revision, this.opts.now?.() ?? new Date()), branches: this.branches };
    for (const fn of this.listeners) fn(this.snapshot);
    return this.snapshot;
  }

  context(extra: Partial<TransitionContext> = {}): TransitionContext {
    return {
      now: (this.opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      newId: newUlid,
      actor: this.opts.identity,
      blobSha,
      ...extra,
    };
  }

  /** Run a transition against the current repo, commit it, refresh. */
  async act(run: (repo: Repo, ctx: TransitionContext) => TransitionResult | Promise<TransitionResult>, ctxExtra: Partial<TransitionContext> = {}): Promise<{ commit: string; snapshot: Snapshot }> {
    await this.refresh();
    const repo = this.repo;
    if (!repo) throw new ActionError(502, "repository not loaded", [], true);
    const result = await run(repo, this.context(ctxExtra));
    if (!result.ok) {
      const first = result.diagnostics[0];
      const status = first && ROLE_RULES.test(first.rule) ? 403 : first?.rule.endsWith(".missing") ? 404 : 409;
      throw new ActionError(status, first?.message ?? "refused", result.diagnostics);
    }
    const report = validateWritePlan(repo, result.plan);
    if (report.blocking) throw new ActionError(409, "write-plan rejected by validation", report.diagnostics.filter((d) => d.blocking));
    let commit: string;
    try {
      commit = await commitWritePlan(this.opts.root, result.plan, { identity: this.opts.identity });
    } catch (e) {
      if (e instanceof GitError) throw new ActionError(502, e.message, [], true);
      throw e;
    }
    const snapshot = await this.refresh(true);
    return { commit, snapshot };
  }
}

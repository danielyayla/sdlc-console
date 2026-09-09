import type { CollectedSources } from "./metrics/index.js";
import { blobSha, commitWritePlan, GitError, headSha, newUlid, readTreeWithBranches, type ArtifactBranch, type GitIdentity } from "@sdlc/adapter-git";
import { loadRepo, rolesOf, validateWritePlan, type MetricSnapshots, type Repo, type TransitionContext, type TransitionResult, type Tree } from "@sdlc/core";
import type { Diagnostic } from "@sdlc/schemas";
import type { SnapshotCache } from "./cache.js";
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
  /** The SDLC home: the repository root, or a product's directory in a monorepo (3.2). */
  root: string;
  identity: GitIdentity;
  /** Hosted mode under a GitHub App (3.2): the App's bot user commits on behalf of `identity`; absent = author and committer are the same. */
  committer?: GitIdentity;
  /** Product name this store serves (`config.products[].name`, or the repository's directory name). */
  product?: string;
  /** Warm start across processes and restarts: the last derived snapshot per tree key. */
  cache?: SnapshotCache;
  ref?: string;
  /** Session provider; receives the current repo so records can be enriched from the ledger. */
  sessions?: (repo: Repo | null) => SessionRecord[];
  now?: () => Date;
  /** External facts for the metrics (GitHub cache overlay); defaults to the git mirror alone. */
  facts?: (repo: Repo) => CollectedSources;
  /** Detection snapshots (3.4) the Bands table reads, from the product's `.sdlc-state/snapshots/`; none by default. */
  snapshots?: () => MetricSnapshots;
}

/**
 * One derived snapshot per HEAD, recomputed on demand; actions run a core
 * transition, validate the write-plan, commit it through the git adapter and
 * refresh. Nothing lifecycle-related is kept in memory beyond the snapshot.
 */
/** The state every view of a store shares: one tree, one snapshot, one revision counter, one listener set. */
interface Shared {
  tree: Tree | null;
  repo: Repo | null;
  snapshot: Snapshot | null;
  branches: ArtifactBranch[];
  revision: number;
  lastHead: string | null;
  listeners: Set<(s: Snapshot) => void>;
  refreshing: Promise<Snapshot> | null;
}

export class StateStore {
  private readonly s: Shared;

  constructor(
    private readonly opts: StoreOptions,
    shared?: Shared,
  ) {
    this.s = shared ?? { tree: null, repo: null, snapshot: null, branches: [], revision: 0, lastHead: null, listeners: new Set(), refreshing: null };
  }

  /**
   * The same store acting as someone else (hosted mode, 3.1): one tree and
   * snapshot for everyone, decisions committed under the person who made
   * them. The server's own identity keeps the engine's commits.
   */
  as(who: GitIdentity): StateStore {
    if (who.id === this.opts.identity.id && who.name === this.opts.identity.name) return this;
    return new StateStore({ ...this.opts, identity: who }, this.s);
  }

  get root(): string {
    return this.opts.root;
  }

  get who(): GitIdentity {
    return this.opts.identity;
  }

  /** The committer of this store's commits when it differs from the author (the GitHub App in hosted mode); null otherwise. */
  get committer(): GitIdentity | null {
    return this.opts.committer ?? null;
  }

  get product(): string | null {
    return this.opts.product ?? null;
  }

  get current(): Snapshot | null {
    return this.s.snapshot;
  }

  get currentRepo(): Repo | null {
    return this.s.repo;
  }

  private get repo(): Repo | null {
    return this.s.repo;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.s.listeners.add(fn);
    return () => this.s.listeners.delete(fn);
  }

  identity(): Identity {
    const roles = this.repo ? rolesOf(this.repo.config, this.opts.identity.id) : [];
    return { id: this.opts.identity.id, name: this.opts.identity.name, roles };
  }

  /** Re-read HEAD and re-derive. Coalesces concurrent calls. */
  refresh(force = false): Promise<Snapshot> {
    const s = this.s;
    if (s.refreshing) return s.refreshing;
    s.refreshing = (async () => {
      try {
        const head = await headSha(this.opts.root, this.opts.ref ?? "HEAD");
        // unmerged artifact branches (drafts in review) are part of what the console shows
        const read = await readTreeWithBranches(this.opts.root, this.opts.ref ?? "HEAD");
        const key = `${head}|${read.branches.map((b) => `${b.branch}@${b.head}`).join(",")}`;
        if (!force && key === s.lastHead && s.snapshot) return s.snapshot;
        s.tree = read.tree;
        s.branches = read.branches;
        s.repo = loadRepo(s.tree);
        s.lastHead = key;
        // a fresh process on a tree another process already derived: serve that derivation until something moves
        const warm = !force && !s.snapshot ? this.opts.cache?.get(key) : null;
        if (warm) {
          s.revision = warm.snapshot.revision;
          s.snapshot = { ...warm.snapshot, identity: this.identity(), sessions: this.opts.sessions?.(s.repo) ?? warm.snapshot.sessions };
          for (const fn of s.listeners) fn(s.snapshot);
          return s.snapshot;
        }
        return this.rebuild();
      } finally {
        s.refreshing = null;
      }
    })();
    return s.refreshing;
  }

  /** Something outside the tree changed (sessions): rebuild the snapshot without re-reading git. The snapshot's identity is the server's; `as(who).identity()` is a viewer's. */
  rebuild(): Snapshot {
    const s = this.s;
    if (!s.repo) throw new Error("store not loaded");
    s.revision += 1;
    s.snapshot = { ...buildSnapshot(s.repo, this.identity(), this.opts.sessions?.(s.repo) ?? [], s.revision, this.opts.now?.() ?? new Date(), this.opts.facts?.(s.repo), this.opts.snapshots?.() ?? {}), branches: s.branches };
    if (s.lastHead) this.opts.cache?.put(s.lastHead, s.snapshot);
    for (const fn of s.listeners) fn(s.snapshot);
    return s.snapshot;
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
      commit = await commitWritePlan(this.opts.root, result.plan, { identity: this.opts.identity, ...(this.opts.committer ? { committer: this.opts.committer } : {}) });
    } catch (e) {
      if (e instanceof GitError) throw new ActionError(502, e.message, [], true);
      throw e;
    }
    const snapshot = await this.refresh(true);
    return { commit, snapshot };
  }
}

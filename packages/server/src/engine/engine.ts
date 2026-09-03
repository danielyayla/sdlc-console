import { deriveChange, proposeTasks, confirmTasks, validateWritePlan, type ChangeView, type Repo } from "@sdlc/core";
import { ARTIFACT_BRANCH, addWorktree, blobSha, branchExists, commitWritePlan, fetchRemote, gitRaw, headSha, listWorktrees, newUlid, type GitIdentity } from "@sdlc/adapter-git";
import { capacityOf, launchSession, worktreePathFor, type SessionKind, type SessionRegistry, type StoredSession } from "../sessions/index.js";
import type { StateStore } from "../store.js";
import { JobStore, type Job } from "./jobs.js";
import { runPerChange, type Exec } from "./runner.js";
import { mirrorReview } from "./review.js";
import { runSuite, type SuiteOutcome } from "./suite.js";
import { nextRunId } from "@sdlc/core";
import type { EvalRun } from "@sdlc/schemas";
import { gitHubCodeHostFrom, type WebhookEvent } from "@sdlc/adapter-github";
import { syncGitHub, type SyncSummary } from "../github/artifacts.js";

export interface EngineOptions {
  store: StateStore;
  registry: SessionRegistry;
  jobs: JobStore;
  sdlcBin: string;
  identity: GitIdentity;
  claudeBin?: string;
  exec?: Exec;
  now?: () => Date;
  /** Launch headless sessions automatically on transitions (opt-in). */
  autoLaunch: boolean;
  log?: (line: string) => void;
  /** Environment for the code host (`GITHUB_TOKEN`); defaults to the process environment. */
  env?: Record<string, string | undefined>;
  /** GitHub mode: minimum gap between PR polls on ticks (default 30 s). */
  syncIntervalMs?: number;
  /** GitHub mode: while webhook deliveries keep arriving, the poll backs off to this gap (default 10 min) — polling is the fallback, not the transport. */
  webhookQuietMs?: number;
}

/** What the engine did with a verified webhook delivery — one line, recorded with the delivery. */
export interface WebhookOutcome {
  outcome: string;
  changeId: string | null;
}

/**
 * Local lifecycle engine (§4.1, build-order 1.7): observes derived state and
 * turns transitions into keyed jobs — design pass after gate 1, plan session
 * after gate 2, task split + build session after gate 3, per-change run when
 * a build session finishes, PR on green, resume on the first red, one review
 * session per PR head at stage 5 and its findings mirrored when it ends.
 */
export class Engine {
  private ticking = false;
  private pending = false;
  private lastSync = 0;
  private lastDelivery = 0;
  private inflight: Promise<SyncSummary | null> | null = null;
  private warnedNoToken = false;
  private closed = false;
  /** Changes whose build session is held by the capacity ceiling; logged once per hold. */
  private readonly ceilingLogged = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: EngineOptions) {
    this.unsubscribe = opts.store.subscribe(() => void this.tick());
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private log(line: string): void {
    this.opts.log?.(`[engine] ${line}`);
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
  }

  /** One pass over the current snapshot; coalesces overlapping calls. */
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.ticking) {
      this.pending = true;
      return;
    }
    this.ticking = true;
    try {
      const repo = this.opts.store.currentRepo;
      if (!repo) return;
      for (const files of repo.changes.values()) {
        const view = deriveChange(repo, files);
        if (!view.valid || view.closed) continue;
        await this.forChange(repo, view).catch((e: unknown) => this.log(`${view.id}: ${(e as Error).message}`));
      }
      if (repo.config.codeHost === "github" && Date.now() - this.lastSync >= this.pollInterval()) await this.sync().catch((e: unknown) => this.log(`github sync: ${(e as Error).message}`));
    } finally {
      this.ticking = false;
      if (this.pending) {
        this.pending = false;
        await this.tick();
      }
    }
  }

  /** Poll every `syncIntervalMs` — unless deliveries are arriving, then every `webhookQuietMs` as the fallback. */
  pollInterval(): number {
    const quiet = this.opts.webhookQuietMs ?? 600_000;
    return Date.now() - this.lastDelivery < quiet ? quiet : (this.opts.syncIntervalMs ?? 30_000);
  }

  /** Last verified webhook delivery (epoch ms), 0 when none arrived in this process. */
  get lastDeliveryAt(): number {
    return this.lastDelivery;
  }

  /** Last GitHub poll (epoch ms), 0 when none ran in this process. */
  get lastSyncAt(): number {
    return this.lastSync;
  }

  /**
   * GitHub mode pass: artifact branches become PRs, merges done on GitHub are
   * recorded, the records PR is refreshed. Null when not in GitHub mode or
   * without a token.
   */
  async sync(): Promise<SyncSummary | null> {
    // one pass at a time; a caller arriving mid-pass (a webhook) gets its own pass afterwards — the merge it reports may have landed after the running pass looked
    while (this.inflight) await this.inflight.catch(() => null);
    if (this.closed) return null;
    this.inflight = this.syncOnce();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async syncOnce(): Promise<SyncSummary | null> {
    await this.opts.store.refresh();
    const repo = this.opts.store.currentRepo;
    if (!repo || repo.config.codeHost !== "github" || this.closed) return null;
    const host = gitHubCodeHostFrom(this.opts.env ?? process.env);
    if (!host) {
      if (!this.warnedNoToken) this.log("config.codeHost is github but GITHUB_TOKEN is not set; artifact PRs and merge detection are off");
      this.warnedNoToken = true;
      return null;
    }
    this.lastSync = Date.now();
    const summary = await syncGitHub({ host, identity: this.opts.identity, ...(this.opts.now ? { now: this.opts.now } : {}), log: (l) => this.log(l) }, this.opts.store);
    if (summary.opened.length > 0 || summary.merges.some((m) => m.recorded)) this.opts.store.rebuild();
    return summary;
  }

  /** The change whose recorded pull request (code PR or artifact PR) has this number. */
  private changeForPull(repo: Repo, number: number): { view: ChangeView; what: "code" | "artifact" } | null {
    for (const files of repo.changes.values()) {
      const view = deriveChange(repo, files);
      if (view.pr?.provider === "github" && view.pr.number === number) return { view, what: "code" };
      if (Object.values(view.artifactPrs).some((p) => p?.number === number)) return { view, what: "artifact" };
    }
    return null;
  }

  /**
   * Bring `origin/<branch>` into the clone: fast-forward the worktree that has
   * it checked out, or the local ref when none does. Diverged history is
   * refused — the console never rewrites a branch. Returns the worktree path
   * when one exists.
   */
  private async fetchBranch(branch: string, createWorktree = false): Promise<{ path: string | null; head: string }> {
    const root = this.opts.store.root;
    await fetchRemote(root, "origin", branch);
    const fetched = (await gitRaw(root, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
    const existing = (await listWorktrees(root)).find((w) => w.branch === branch);
    if (existing) {
      // FETCH_HEAD is per worktree; the fetched sha is not
      const ff = await gitRaw(existing.path, ["merge", "--ff-only", "--quiet", fetched]);
      if (ff.code !== 0) throw new Error(`${branch}: the local worktree at ${existing.path} diverged from origin (${fetched.slice(0, 7)}); reconcile it by hand — the console never rewrites a branch`);
      return { path: existing.path, head: fetched };
    }
    if (await branchExists(root, branch)) {
      const ff = await gitRaw(root, ["fetch", "--quiet", "origin", `${branch}:${branch}`]);
      if (ff.code !== 0) throw new Error(`${branch}: the local branch diverged from origin (${fetched.slice(0, 7)}); reconcile it by hand — the console never rewrites a branch`);
    } else {
      await gitRaw(root, ["branch", branch, fetched]);
    }
    if (!createWorktree) return { path: null, head: fetched };
    const path = worktreePathFor(root, branch);
    await addWorktree(root, path, branch);
    return { path, head: fetched };
  }

  /**
   * A verified delivery (2.4). Payloads are data: this routes on the PR
   * number, head and branch, then fetches and re-derives from git; the merger
   * identity comes from the API, never from the body. Every downstream job is
   * keyed on the head it concerns, so a re-sent event finds its work claimed.
   */
  async onWebhook(event: WebhookEvent): Promise<WebhookOutcome> {
    this.lastDelivery = Date.now();
    const repo = this.opts.store.currentRepo ?? (await this.opts.store.refresh(), this.opts.store.currentRepo);
    if (!repo) return { outcome: "repository not loaded", changeId: null };
    const base = repo.config.defaultBranch;
    switch (event.kind) {
      case "ping":
        return { outcome: "pong", changeId: null };
      case "pull_request": {
        const hit = this.changeForPull(repo, event.number);
        const id = hit?.view.id ?? null;
        if (event.action === "closed") {
          if (!event.merged) return { outcome: `PR #${event.number} closed without merge${id ? ` (${id}); nothing recorded` : ""}`, changeId: id };
          const summary = await this.sync();
          if (!summary) return { outcome: `PR #${event.number} merged, but GitHub sync is off (GITHUB_TOKEN not set): nothing recorded`, changeId: id };
          const m = summary.merges.find((x) => x.number === event.number);
          // a recorded PR the sync no longer lists as a candidate is one whose merge is already recorded (a re-sent event)
          if (!m) return { outcome: hit ? `${hit.view.id}: PR #${event.number} merge already recorded` : `PR #${event.number} merged: not a recorded pull request`, changeId: id };
          return { outcome: m.recorded ? `${m.changeId}: gate ${m.gate} recorded from PR #${m.number} merged by ${m.mergedBy}` : `${m.changeId}: PR #${m.number} merged by ${m.mergedBy}, not recorded: ${m.reason ?? ""}`, changeId: m.changeId };
        }
        if (event.action === "synchronize") {
          if (hit?.what === "code") return { outcome: (await this.runForPrHead(hit.view.id, event.headSha, "webhook")).note, changeId: id };
          if (ARTIFACT_BRANCH.test(event.headRef)) return this.fetchArtifactBranch(event.headRef, id);
          return { outcome: `PR #${event.number} (${event.headRef}) is not a recorded pull request`, changeId: id };
        }
        if (event.action === "opened" || event.action === "reopened" || event.action === "ready_for_review") {
          if (!ARTIFACT_BRANCH.test(event.headRef) && !hit) return { outcome: `PR #${event.number} (${event.headRef}) ${event.action}: not a branch the console tracks`, changeId: null };
          const summary = await this.sync();
          return { outcome: summary ? `PR #${event.number} ${event.action}: synced (${summary.opened.length} artifact PR(s) recorded)` : `PR #${event.number} ${event.action}: GitHub sync is off`, changeId: id };
        }
        return { outcome: `PR #${event.number} ${event.action}: noted`, changeId: id };
      }
      case "pull_request_review": {
        const hit = this.changeForPull(repo, event.number);
        this.opts.store.rebuild();
        return { outcome: `review ${event.state} by ${event.author ?? "?"} on PR #${event.number}${hit ? ` (${hit.view.id})` : ""} noted; gate decisions are recorded from merges`, changeId: hit?.view.id ?? null };
      }
      case "check_run":
      case "status": {
        const sha = event.kind === "check_run" ? event.headSha : event.sha;
        const label = event.kind === "check_run" ? `check ${event.name} ${event.conclusion ?? event.status}` : `status ${event.context} ${event.state}`;
        for (const files of repo.changes.values()) {
          const view = deriveChange(repo, files);
          if (view.pr?.headSha === sha && view.pr.mergedAt === undefined) return { outcome: `${label} on ${view.id}'s PR head ${sha.slice(0, 7)}: noted (CI verdicts reach the console through committed run files, item 2.5)`, changeId: view.id };
        }
        return { outcome: `${label} on ${sha.slice(0, 7)}: no recorded PR head`, changeId: null };
      }
      case "push": {
        const branch = event.ref.replace(/^refs\/heads\//, "");
        if (event.ref === branch) return { outcome: `push to ${event.ref}: not a branch`, changeId: null };
        if (event.deleted) return { outcome: `${branch} deleted on origin: nothing to do`, changeId: null };
        if (branch === base) {
          const summary = await this.sync();
          return { outcome: summary ? `origin/${base} moved to ${event.after.slice(0, 7)}: synced (${summary.merges.filter((m) => m.recorded).length} merge(s) recorded)` : `origin/${base} moved to ${event.after.slice(0, 7)}, but GitHub sync is off`, changeId: null };
        }
        if (ARTIFACT_BRANCH.test(branch)) return this.fetchArtifactBranch(branch, ARTIFACT_BRANCH.exec(branch)?.[1] ?? null);
        for (const files of repo.changes.values()) {
          const view = deriveChange(repo, files);
          if (view.pr?.branch === branch && view.pr.mergedAt === undefined) return { outcome: `push to ${branch} (${view.id}): the pull_request.synchronize delivery runs the new head`, changeId: view.id };
        }
        return { outcome: `push to ${branch}: not a branch the console tracks`, changeId: null };
      }
      default:
        return { outcome: `ignored ${event.event}${event.action ? `.${event.action}` : ""}`, changeId: null };
    }
  }

  private async fetchArtifactBranch(branch: string, changeId: string | null): Promise<WebhookOutcome> {
    const { head } = await this.fetchBranch(branch);
    await this.opts.store.refresh(true);
    return { outcome: `${branch} fetched to ${head.slice(0, 7)}`, changeId };
  }

  /**
   * The code PR's head moved on origin: fetch it into the branch worktree and
   * run the per-change run on it. Green records the new head on `pr.yaml`
   * (`pr.synchronized`) so the stale review is relaunched; red leaves the old
   * tested head as the merge precondition.
   */
  async runForPrHead(changeId: string, expectedHead: string | null, trigger = "webhook"): Promise<{ job: Job | null; note: string }> {
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    const files = repo?.changes.get(changeId);
    if (!repo || !files) return { job: null, note: `${changeId} not found` };
    const view = deriveChange(repo, files);
    const pr = view.pr;
    if (!pr || pr.mergedAt !== undefined) return { job: null, note: `${changeId}: no open pull request` };
    const live = this.opts.registry.list().some((s) => s.changeId === changeId && s.kind === "build" && (s.status === "running" || s.status === "waiting" || s.status === "awaiting_engineer"));
    if (live) return { job: null, note: `${changeId}: a build session is running on ${pr.branch}; the run follows its exit` };
    const fetched = await this.fetchBranch(pr.branch, true);
    const wt = fetched.path ?? worktreePathFor(this.opts.store.root, pr.branch);
    const head = await headSha(wt, "HEAD");
    if (head === pr.headSha) return { job: null, note: `${changeId}: PR head ${head.slice(0, 7)} is already the tested head` };
    const session = this.opts.registry.list().find((s) => s.changeId === changeId && s.kind === "build" && s.branch === pr.branch);
    const job = await this.runForSession({ ...(session ?? this.fakeSession(view, pr.branch)), worktreePath: wt, status: "done" }, trigger);
    const moved = expectedHead && expectedHead !== head ? ` (delivery said ${expectedHead.slice(0, 7)}, origin is at ${head.slice(0, 7)})` : "";
    return { job, note: job ? `${changeId}: run on ${head.slice(0, 7)}${moved} → ${job.state === "failed" ? `failed: ${job.error ?? ""}` : (job.note ?? job.state)}` : `${changeId}: run on ${head.slice(0, 7)} already claimed` };
  }

  private fakeSession(view: ChangeView, branch: string, taskId: string | null = null): StoredSession {
    return { id: `manual-${view.id}`, kind: "build", cycle: view.cycle, resumeCount: 0, worktree: branch, worktreePath: worktreePathFor(this.opts.store.root, branch), branch, changeId: view.id, taskId, mode: "SUPERVISED", engineer: this.opts.identity.id, startedAt: this.now(), heartbeatAt: this.now(), status: "done", target: view.acceptanceLine, files: view.planFiles, subagents: [], loop: { state: "not-run", rounds: [] }, verifier: null, testEditAttempts: 0, waitingOnYou: null, autoRationale: { terms: [] }, modelPin: null, contextManifestRef: null, transcriptRef: null, harnessSessionId: "", pid: null, exitCode: null, command: "", capRaised: false, reviewed: false, costUsd: null, numTurns: null, lastLine: null, error: null };
  }

  private async forChange(repo: Repo, view: ChangeView): Promise<void> {
    if (!this.opts.autoLaunch) return;
    const sha = (i: 0 | 1 | 2) => view.docs[i].sha ?? "none";
    if (view.stage === 2 && view.agent) await this.launch(view, `${view.id}:${view.cycle}:2:${sha(0)}`, "design-pass", "design");
    if (view.stage === 3 && view.agent && view.planState === "none") await this.launch(view, `${view.id}:${view.cycle}:3:${sha(1)}`, "plan-session", "plan");
    if (view.stage === 4 && view.tasks.length === 0) await this.confirmSplit(repo, view, `${view.id}:${view.cycle}:4:${sha(2)}:split`);
    if (view.stage === 4 && view.tasks.length > 0 && (view.evalsState === "running" || view.evalsState === "red")) {
      // start a build session when none exists yet; a red run with an existing session is handled by the resume path
      const sessions = this.opts.registry.list().filter((s) => s.changeId === view.id && s.kind === "build" && s.cycle === view.cycle);
      const live = sessions.some((s) => s.status === "running" || s.status === "waiting" || s.status === "awaiting_engineer");
      const runs = repo.changes.get(view.id)?.runs.filter((r) => r.cycle === view.cycle).length ?? 0;
      if (!live && (view.evalsState === "running" || sessions.length === 0)) {
        // FR-35: over the ceiling nothing is claimed, so the next tick after the backlog clears launches it
        const capacity = capacityOf(this.opts.registry.list(), repo);
        if (capacity.over) {
          if (!this.ceilingLogged.has(view.id)) this.log(`${view.id}: build session held — review backlog ${capacity.backlog} over the ceiling ${capacity.ceiling}`);
          this.ceilingLogged.add(view.id);
        } else {
          this.ceilingLogged.delete(view.id);
          await this.launch(view, `${view.id}:${view.cycle}:4:${sha(2)}:build:run-${runs}`, "build-session", "build");
        }
      }
    }
    // stage 5: one review per PR head; `pr.review.headSha` (in git) is what makes this idempotent across restarts
    if (view.stage === 5 && view.pr && view.pr.mergedAt === undefined && view.pr.review?.headSha !== view.pr.headSha) {
      const live = this.opts.registry.list().some((s) => s.changeId === view.id && s.kind === "review" && (s.status === "running" || s.status === "waiting" || s.status === "awaiting_engineer"));
      if (!live) await this.launch(view, `${view.id}:${view.cycle}:5:review:${view.pr.headSha.slice(0, 12)}`, "review", "review");
    }
  }

  private async launch(view: ChangeView, key: string, kind: Job["kind"], sessionKind: Exclude<SessionKind, "intent" | "diagnose">): Promise<void> {
    const job = this.opts.jobs.claim({ key, kind, changeId: view.id, cycle: view.cycle, stage: view.stage }, this.now());
    if (!job) return;
    try {
      const r = await launchSession(
        { changeId: view.id, kind: sessionKind, ...(sessionKind === "build" ? { mode: view.autoEligible.value ? ("AUTO" as const) : ("SUPERVISED" as const) } : {}) },
        { root: this.opts.store.root, registry: this.opts.registry, sdlcBin: this.opts.sdlcBin, identity: this.opts.identity, ...(this.opts.claudeBin ? { claudeBin: this.opts.claudeBin } : {}), ...(this.opts.now ? { now: this.opts.now } : {}), onExit: (s) => void this.onSessionExit(s) },
      );
      this.opts.jobs.update(key, { sessionId: r.session.id, state: r.session.mode === "SUPERVISED" ? "done" : "running", note: r.session.mode === "SUPERVISED" ? "prepared for the engineer" : null }, this.now());
      this.log(`${view.id}: ${kind} → session ${r.session.id} (${r.session.mode})`);
      this.opts.store.rebuild();
    } catch (e) {
      this.opts.jobs.update(key, { state: "failed", error: (e as Error).message }, this.now());
      this.log(`${view.id}: ${kind} failed: ${(e as Error).message}`);
    }
  }

  private async confirmSplit(repo: Repo, view: ChangeView, key: string): Promise<void> {
    const job = this.opts.jobs.claim({ key, kind: "build-session", changeId: view.id, cycle: view.cycle, stage: 4 }, this.now());
    if (!job) return;
    try {
      const proposed = proposeTasks(view.planFiles, view.acceptanceLine);
      const r = confirmTasks(repo, view, proposed, { now: this.now(), newId: newUlid, actor: { id: this.opts.identity.id }, blobSha });
      if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join("; "));
      const report = validateWritePlan(repo, r.plan);
      if (report.blocking) throw new Error(`task split rejected by validation: ${report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ")}`);
      await commitWritePlan(this.opts.store.root, r.plan, { identity: this.opts.identity });
      this.opts.jobs.update(key, { state: "done", note: `${proposed.length} tasks confirmed` }, this.now());
      await this.opts.store.refresh(true);
    } catch (e) {
      this.opts.jobs.update(key, { state: "failed", error: (e as Error).message }, this.now());
      this.log(`${view.id}: task split failed: ${(e as Error).message}`);
    }
  }

  /** A build session finished: run the per-change run; green → PR; red → resume once, then wait. */
  async onSessionExit(session: StoredSession): Promise<void> {
    if (this.closed) return;
    // the job that launched this session is finished with it
    for (const job of this.opts.jobs.list()) {
      if (job.sessionId === session.id && job.state === "running") {
        const downgraded = session.status === "awaiting_engineer";
        this.opts.jobs.update(job.key, { state: session.status === "done" || downgraded ? "done" : "failed", ...(downgraded ? { note: "downgraded to SUPERVISED — the engineer continues" } : {}), ...(session.error ? { error: session.error } : {}) }, this.now());
      }
    }
    if (session.kind === "review" && session.status === "done") {
      await this.mirrorForSession(session);
      return;
    }
    if (session.kind !== "build" || session.status !== "done") {
      this.opts.store.rebuild();
      return;
    }
    await this.runForSession(session);
  }

  /** A review session finished: mirror its findings into the change and onto the PR (once per session). */
  async mirrorForSession(session: StoredSession): Promise<Job | null> {
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    const files = repo?.changes.get(session.changeId);
    if (!repo || !files) return null;
    const view = deriveChange(repo, files);
    const key = `${session.changeId}:${view.cycle}:5:review-mirror:${session.id}`;
    const job = this.opts.jobs.claim({ key, kind: "review-mirror", changeId: session.changeId, cycle: view.cycle, stage: 5 }, this.now());
    if (!job) return null;
    try {
      const outcome = await mirrorReview({ root: this.opts.store.root, view, session, ...(this.opts.now ? { now: this.opts.now } : {}), ...(this.opts.env ? { env: this.opts.env } : {}) }, repo);
      this.opts.jobs.update(key, { state: "done", note: `review of ${outcome.headSha.slice(0, 7)}: ${outcome.tally.high} high · ${outcome.tally.medium} medium · ${outcome.tally.low} low` }, this.now());
      this.log(`${view.id}: review of ${outcome.headSha.slice(0, 7)} mirrored (${outcome.count} findings, ${outcome.verdict})`);
      this.opts.registry.patch(session.id, { reviewed: true });
      await this.opts.store.refresh(true);
    } catch (e) {
      this.opts.jobs.update(key, { state: "failed", error: (e as Error).message }, this.now());
      this.log(`${view.id}: review mirror failed: ${(e as Error).message}`);
      this.opts.store.rebuild();
    }
    return this.opts.jobs.get(key);
  }

  /** `trigger` names a run outside the session-exit path (`manual`, `webhook`); it is part of the job key. */
  async runForSession(session: StoredSession, trigger: string | null = null): Promise<Job | null> {
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    if (!repo) return null;
    const files = repo.changes.get(session.changeId);
    if (!files) return null;
    const view = deriveChange(repo, files);
    // one run per (session, worktree head): a replayed exit cannot double-run, new code can
    const head = await headSha(session.worktreePath, "HEAD").catch(() => "nohead");
    const key = `${session.changeId}:${view.cycle}:4:run:${session.id}:r${session.resumeCount ?? 0}:${head.slice(0, 12)}${trigger ? `:${trigger}` : ""}`;
    const job = this.opts.jobs.claim({ key, kind: "per-change-run", changeId: session.changeId, cycle: view.cycle, stage: 4 }, this.now());
    if (!job) return null;
    try {
      const outcome = await runPerChange({ root: this.opts.store.root, view, worktree: session.worktreePath, branch: session.branch, ...(this.opts.exec ? { exec: this.opts.exec } : {}), ...(this.opts.now ? { now: this.opts.now } : {}), ...(this.opts.env ? { env: this.opts.env } : {}) }, repo);
      this.opts.jobs.update(key, { state: "done", note: `run ${outcome.run.n} ${outcome.run.verdict}${outcome.prAction === "opened" ? " · PR opened" : outcome.prAction === "synchronized" ? ` · PR head → ${outcome.run.headSha.slice(0, 7)}` : ""}` }, this.now());
      this.log(`${view.id}: run ${outcome.run.n} ${outcome.run.verdict}`);
      this.opts.registry.patch(session.id, { reviewed: outcome.run.verdict === "green" });
      await this.opts.store.refresh(true);
      if (outcome.run.verdict === "red" && outcome.consecutiveReds === 1 && this.opts.autoLaunch && session.mode !== "SUPERVISED") {
        const failing = [...outcome.run.commandResults.filter((r) => !r.pass).map((r) => `--- ${r.name}: ${r.cmd} (exit ${r.exitCode})\n${r.output.slice(-3000)}`), ...outcome.run.results.filter((r) => !r.pass).map((r) => `--- eval ${r.caseId}\n${r.output.slice(-3000)}`)].join("\n");
        const resumeKey = `${session.changeId}:${view.cycle}:4:run-${outcome.run.n}:resume`;
        if (this.opts.jobs.claim({ key: resumeKey, kind: "resume-session", changeId: session.changeId, cycle: view.cycle, stage: 4 }, this.now())) {
          try {
            const r = await launchSession(
              { changeId: session.changeId, kind: "build", taskId: session.taskId ?? undefined, target: session.target ?? undefined, mode: session.mode, resume: { sessionId: session.id, guidance: `The per-change run ${outcome.run.n} is red. Fix these failures, record rounds with mcp__sdlc__report_round, and call mcp__sdlc__report_done when green:\n${failing}` } },
              { root: this.opts.store.root, registry: this.opts.registry, sdlcBin: this.opts.sdlcBin, identity: this.opts.identity, ...(this.opts.claudeBin ? { claudeBin: this.opts.claudeBin } : {}), ...(this.opts.now ? { now: this.opts.now } : {}), onExit: (s) => void this.onSessionExit(s) },
            );
            this.opts.jobs.update(resumeKey, { state: "running", sessionId: r.session.id }, this.now());
          } catch (e) {
            this.opts.jobs.update(resumeKey, { state: "failed", error: (e as Error).message }, this.now());
          }
        }
      }
      return this.opts.jobs.get(key);
    } catch (e) {
      this.opts.jobs.update(key, { state: "failed", error: (e as Error).message }, this.now());
      this.log(`${view.id}: run failed: ${(e as Error).message}`);
      return this.opts.jobs.get(key);
    }
  }

  /**
   * Eval suite run as a keyed job (`evals:<trigger>:<RUN-id>`): the console
   * queues it and returns; the CLI waits. The run file and any triage items
   * are committed on the default branch by sdlc-bot.
   */
  async runSuite(trigger: EvalRun["trigger"], wait = true): Promise<{ job: Job | null; outcome: SuiteOutcome | null }> {
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    if (!repo) return { job: null, outcome: null };
    const key = `evals:${trigger}:${nextRunId(repo.evalRuns)}`;
    const job = this.opts.jobs.claim({ key, kind: "evals-run", changeId: "", cycle: 0, stage: 4 }, this.now());
    if (!job) return { job: this.opts.jobs.get(key), outcome: null };
    const work = (async (): Promise<SuiteOutcome | null> => {
      try {
        const outcome = await runSuite({ root: this.opts.store.root, repo, trigger, ...(this.opts.exec ? { exec: this.opts.exec } : {}), ...(this.opts.now ? { now: this.opts.now } : {}), ...(this.opts.env ? { env: this.opts.env } : {}), log: (l) => this.log(l) });
        const note = outcome.skipped ?? `${outcome.run?.id ?? "run"} ${outcome.run?.verdict ?? ""} · ${Math.round((outcome.run?.passRate ?? 0) * 100)}% (${outcome.run?.results.filter((r) => r.pass).length ?? 0}/${outcome.run?.results.length ?? 0})${outcome.signals.length > 0 ? ` · ${outcome.signals.length} triage item(s)` : ""}`;
        this.opts.jobs.update(key, { state: outcome.skipped ? "skipped" : "done", note }, this.now());
        await this.opts.store.refresh(true);
        return outcome;
      } catch (e) {
        this.opts.jobs.update(key, { state: "failed", error: (e as Error).message }, this.now());
        this.log(`evals: ${(e as Error).message}`);
        await this.opts.store.refresh(true).catch(() => undefined);
        return null;
      }
    })();
    if (!wait) {
      void work;
      return { job, outcome: null };
    }
    const outcome = await work;
    return { job: this.opts.jobs.get(key), outcome };
  }

  /** Manual per-change run for a change: uses its most recent build session's worktree, or the task branch worktree. */
  async runForChange(changeId: string): Promise<Job | null> {
    const session = this.opts.registry.list().find((s) => s.changeId === changeId && s.kind === "build");
    if (session) return this.runForSession(session, "manual");
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    const files = repo?.changes.get(changeId);
    if (!repo || !files) return null;
    const view = deriveChange(repo, files);
    const task = view.tasks[0];
    return this.runForSession(this.fakeSession(view, task?.branch ?? `${changeId}/work`, task?.id ?? null), "manual");
  }
}

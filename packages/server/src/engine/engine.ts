import { deriveChange, proposeTasks, confirmTasks, validateWritePlan, type ChangeView, type Repo } from "@sdlc/core";
import { blobSha, commitWritePlan, headSha, newUlid, type GitIdentity } from "@sdlc/adapter-git";
import { launchSession, worktreePathFor, type SessionRegistry, type StoredSession } from "../sessions/index.js";
import type { StateStore } from "../store.js";
import { JobStore, type Job } from "./jobs.js";
import { runPerChange, type Exec } from "./runner.js";

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
}

/**
 * Local lifecycle engine (§4.1, build-order 1.7): observes derived state and
 * turns transitions into keyed jobs — design pass after gate 1, plan session
 * after gate 2, task split + build session after gate 3, per-change run when
 * a build session finishes, PR on green, resume on the first red.
 */
export class Engine {
  private ticking = false;
  private pending = false;
  private closed = false;
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
    } finally {
      this.ticking = false;
      if (this.pending) {
        this.pending = false;
        await this.tick();
      }
    }
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
      if (!live && (view.evalsState === "running" || sessions.length === 0)) await this.launch(view, `${view.id}:${view.cycle}:4:${sha(2)}:build:run-${runs}`, "build-session", "build");
    }
  }

  private async launch(view: ChangeView, key: string, kind: Job["kind"], sessionKind: "design" | "plan" | "build"): Promise<void> {
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
        this.opts.jobs.update(job.key, { state: session.status === "done" ? "done" : "failed", ...(session.error ? { error: session.error } : {}) }, this.now());
      }
    }
    if (session.kind !== "build" || session.status !== "done") {
      this.opts.store.rebuild();
      return;
    }
    await this.runForSession(session);
  }

  async runForSession(session: StoredSession, manual = false): Promise<Job | null> {
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    if (!repo) return null;
    const files = repo.changes.get(session.changeId);
    if (!files) return null;
    const view = deriveChange(repo, files);
    // one run per (session, worktree head): a replayed exit cannot double-run, new code can
    const head = await headSha(session.worktreePath, "HEAD").catch(() => "nohead");
    const key = `${session.changeId}:${view.cycle}:4:run:${session.id}:r${session.resumeCount ?? 0}:${head.slice(0, 12)}${manual ? ":manual" : ""}`;
    const job = this.opts.jobs.claim({ key, kind: "per-change-run", changeId: session.changeId, cycle: view.cycle, stage: 4 }, this.now());
    if (!job) return null;
    try {
      const outcome = await runPerChange({ root: this.opts.store.root, view, worktree: session.worktreePath, branch: session.branch, ...(this.opts.exec ? { exec: this.opts.exec } : {}), ...(this.opts.now ? { now: this.opts.now } : {}) }, repo);
      this.opts.jobs.update(key, { state: "done", note: `run ${outcome.run.n} ${outcome.run.verdict}${outcome.prCommit ? " · PR opened" : ""}` }, this.now());
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

  /** Manual per-change run for a change: uses its most recent build session's worktree, or the task branch worktree. */
  async runForChange(changeId: string): Promise<Job | null> {
    const session = this.opts.registry.list().find((s) => s.changeId === changeId && s.kind === "build");
    if (session) return this.runForSession(session, true);
    await this.opts.store.refresh(true);
    const repo = this.opts.store.currentRepo;
    const files = repo?.changes.get(changeId);
    if (!repo || !files) return null;
    const view = deriveChange(repo, files);
    const task = view.tasks[0];
    const branch = task?.branch ?? `${changeId}/work`;
    const fake: StoredSession = { id: `manual-${changeId}`, kind: "build", cycle: view.cycle, resumeCount: 0, worktree: branch, worktreePath: worktreePathFor(this.opts.store.root, branch), branch, changeId, taskId: task?.id ?? null, mode: "SUPERVISED", engineer: this.opts.identity.id, startedAt: this.now(), heartbeatAt: this.now(), status: "done", target: view.acceptanceLine, files: view.planFiles, subagents: [], loop: { state: "not-run", rounds: [] }, verifier: null, testEditAttempts: 0, waitingOnYou: null, autoRationale: { terms: [] }, modelPin: null, contextManifestRef: null, transcriptRef: null, harnessSessionId: "", pid: null, exitCode: null, command: "", capRaised: false, reviewed: false, costUsd: null, numTurns: null, lastLine: null, error: null };
    return this.runForSession(fake, true);
  }
}

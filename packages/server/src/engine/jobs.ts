import type Database from "better-sqlite3";
import { noopTracer, type Span, type SpanContext, type Tracer } from "../otel.js";

export type JobKind = "design-pass" | "plan-session" | "build-session" | "per-change-run" | "open-pr" | "resume-session" | "review" | "review-mirror" | "evals-run" | "claude-md-proposal" | "proposal-mirror" | "record-writeback" | "diagnose" | "propose" | "band-record";
export type JobState = "queued" | "running" | "done" | "failed" | "skipped";

export interface Job {
  key: string;
  kind: JobKind;
  changeId: string;
  cycle: number;
  stage: number;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  error: string | null;
  note: string | null;
  /** The OTel trace the job's span belongs to (3.3); null without an exporter. */
  traceId: string | null;
}

const TERMINAL = new Set<JobState>(["done", "failed", "skipped"]);

/** Jobs keyed `<change>:<cycle>:<stage>:<artifactSha>[:kind]` so a replayed trigger cannot double-launch (§4.1). */
export class JobStore {
  /** Open `sdlc.job` spans of jobs this process claimed; a job another process claimed has no span here. */
  private readonly spans = new Map<string, Span>();
  /** The last span context per key, so a re-run (a write-back retry) joins the same trace. */
  private readonly contexts = new Map<string, SpanContext>();

  constructor(
    private readonly db: Database.Database,
    private readonly tracer: Tracer = noopTracer,
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, json TEXT NOT NULL, createdAt TEXT NOT NULL)");
  }

  private parse(json: string): Job {
    const job = JSON.parse(json) as Partial<Job> & Omit<Job, "traceId">;
    return { ...job, traceId: job.traceId ?? null };
  }

  get(key: string): Job | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT json FROM jobs WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? this.parse(row.json) : null;
  }

  list(): Job[] {
    if (!this.db.open) return [];
    return (this.db.prepare("SELECT json FROM jobs ORDER BY createdAt DESC").all() as { json: string }[]).map((r) => this.parse(r.json));
  }

  /** The open span of a job this process is running (the parent for its run's span); null otherwise. */
  spanOf(key: string): Span | null {
    return this.spans.get(key) ?? null;
  }

  private open(job: Pick<Job, "key" | "kind" | "changeId" | "cycle" | "stage">, now: string): Span {
    const span = this.tracer.startSpan("sdlc.job", {
      attributes: { "sdlc.job.key": job.key, "sdlc.job.kind": job.kind, "sdlc.change": job.changeId || null, "sdlc.cycle": job.cycle || null, "sdlc.stage": job.stage || null, "sdlc.job.queued_at": now },
      parent: this.contexts.get(job.key) ?? null,
    });
    const ctx = span.context();
    if (ctx) this.contexts.set(job.key, ctx);
    this.spans.set(job.key, span);
    return span;
  }

  private close(key: string, job: Job): void {
    const span = this.spans.get(key);
    if (!span) return;
    this.spans.delete(key);
    span.setAttributes({ "sdlc.job.state": job.state, "sdlc.session.id": job.sessionId, "sdlc.job.note": job.note, "sdlc.job.error": job.error });
    span.end(job.state === "failed" ? { ok: false, ...(job.error ? { message: job.error } : {}) } : { ok: true });
  }

  /**
   * Claim a key; null when the job already exists (idempotent). The primary
   * key does the arbitration inside SQLite, so two operators' processes on
   * the same cache (3.2) cannot both claim it — one insert wins, the other
   * sees zero rows changed.
   */
  claim(job: Omit<Job, "state" | "createdAt" | "updatedAt" | "sessionId" | "error" | "note" | "traceId">, now: string): Job | null {
    if (!this.db.open) return null;
    const full: Job = { ...job, state: "running", createdAt: now, updatedAt: now, sessionId: null, error: null, note: null, traceId: null };
    // the span starts at the claim (the queue moment); a losing claim gets no span
    const probe = this.db.prepare("SELECT 1 FROM jobs WHERE key = ?").get(full.key);
    if (probe) return null;
    const span = this.open(full, now);
    full.traceId = span.traceId;
    const r = this.db.prepare("INSERT OR IGNORE INTO jobs (key, json, createdAt) VALUES (?, ?, ?)").run(full.key, JSON.stringify(full), now);
    if (r.changes === 1) return full;
    this.spans.delete(full.key);
    span.end({ ok: true });
    return null;
  }

  update(key: string, patch: Partial<Job>, now: string): Job | null {
    const cur = this.get(key);
    if (!cur || !this.db.open) return null;
    const next: Job = { ...cur, ...patch, updatedAt: now };
    // a finished job re-run (a write-back retry) gets a new span in the same trace
    if (patch.state === "running" && !this.spans.has(key) && TERMINAL.has(cur.state)) next.traceId = this.open(next, now).traceId ?? next.traceId;
    this.db.prepare("UPDATE jobs SET json = ? WHERE key = ?").run(JSON.stringify(next), key);
    if (TERMINAL.has(next.state)) this.close(key, next);
    return next;
  }
}

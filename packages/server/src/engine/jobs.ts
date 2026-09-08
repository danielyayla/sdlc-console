import type Database from "better-sqlite3";

export type JobKind = "design-pass" | "plan-session" | "build-session" | "per-change-run" | "open-pr" | "resume-session" | "review" | "review-mirror" | "evals-run" | "claude-md-proposal" | "proposal-mirror" | "record-writeback";
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
}

/** Jobs keyed `<change>:<cycle>:<stage>:<artifactSha>[:kind]` so a replayed trigger cannot double-launch (§4.1). */
export class JobStore {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, json TEXT NOT NULL, createdAt TEXT NOT NULL)");
  }

  get(key: string): Job | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT json FROM jobs WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Job) : null;
  }

  list(): Job[] {
    if (!this.db.open) return [];
    return (this.db.prepare("SELECT json FROM jobs ORDER BY createdAt DESC").all() as { json: string }[]).map((r) => JSON.parse(r.json) as Job);
  }

  /**
   * Claim a key; null when the job already exists (idempotent). The primary
   * key does the arbitration inside SQLite, so two operators' processes on
   * the same cache (3.2) cannot both claim it — one insert wins, the other
   * sees zero rows changed.
   */
  claim(job: Omit<Job, "state" | "createdAt" | "updatedAt" | "sessionId" | "error" | "note">, now: string): Job | null {
    if (!this.db.open) return null;
    const full: Job = { ...job, state: "running", createdAt: now, updatedAt: now, sessionId: null, error: null, note: null };
    const r = this.db.prepare("INSERT OR IGNORE INTO jobs (key, json, createdAt) VALUES (?, ?, ?)").run(full.key, JSON.stringify(full), now);
    return r.changes === 1 ? full : null;
  }

  update(key: string, patch: Partial<Job>, now: string): Job | null {
    const cur = this.get(key);
    if (!cur || !this.db.open) return null;
    const next = { ...cur, ...patch, updatedAt: now };
    this.db.prepare("UPDATE jobs SET json = ? WHERE key = ?").run(JSON.stringify(next), key);
    return next;
  }
}

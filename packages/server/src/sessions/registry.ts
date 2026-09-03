import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Repo } from "@sdlc/core";
import { eventsNamed } from "@sdlc/core";
import { loopState, readReproDraft, readRounds, type ReproDraft, type StoredRound } from "@sdlc/mcp";
import type { RoundResult } from "@sdlc/schemas";
import type { SessionRecord } from "../snapshot.js";

export type SessionKind = "intent" | "design" | "plan" | "build" | "review" | "diagnose" | "propose";
export type SessionStatus = "running" | "waiting" | "done" | "error" | "stopped" | "taken_over" | "awaiting_engineer";

/** Runtime record (C): rebuildable; the ledger keeps the summary lines. */
export interface SessionLoop {
  state: string;
  rounds: { n: number; ts: string; results: RoundResult[]; screenshotRef?: string; diffPct?: number }[];
}

export interface StoredSession extends SessionRecord {
  loop: SessionLoop;
  /** The repro test this build session reported and the engineer has not yet judged (fix changes, spec 5B.3). */
  repro?: ReproDraft | null;
  waitingOnYou: { reason: string } | null;
  verifier: { ran: boolean; saw: boolean; mismatch: boolean } | null;
  testEditAttempts: number;
  subagents: { name: string; state: string }[];
  autoRationale: { terms: string[] };
  files: string[];
  modelPin: string | null;
  contextManifestRef: string | null;
  transcriptRef: string | null;
  kind: SessionKind;
  cycle: number;
  /** Times the session was resumed with guidance; part of the run idempotency key. */
  resumeCount: number;
  worktreePath: string;
  harnessSessionId: string;
  pid: number | null;
  exitCode: number | null;
  command: string;
  capRaised: boolean;
  reviewed: boolean;
  costUsd: number | null;
  numTurns: number | null;
  lastLine: string | null;
  error: string | null;
}

interface Row {
  id: string;
  json: string;
}

/** SQLite-backed session registry under `.sdlc-state/sessions.db` (decisions P11: disposable cache). */
export class SessionRegistry {
  private readonly db: Database.Database;

  constructor(readonly root: string, file = join(root, ".sdlc-state", "sessions.db")) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, changeId TEXT NOT NULL, startedAt TEXT NOT NULL, json TEXT NOT NULL)");
  }

  upsert(s: StoredSession): StoredSession {
    if (!this.db.open) return s;
    this.db.prepare("INSERT INTO sessions (id, changeId, startedAt, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET changeId = excluded.changeId, startedAt = excluded.startedAt, json = excluded.json").run(s.id, s.changeId, s.startedAt, JSON.stringify(s));
    return s;
  }

  patch(id: string, partial: Partial<StoredSession>): StoredSession | null {
    const cur = this.get(id);
    if (!cur) return null;
    return this.upsert({ ...cur, ...partial });
  }

  get(id: string): StoredSession | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT id, json FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(row.json) as StoredSession) : null;
  }

  list(): StoredSession[] {
    if (!this.db.open) return [];
    const rows = this.db.prepare("SELECT id, json FROM sessions ORDER BY startedAt DESC").all() as Row[];
    return rows.map((r) => JSON.parse(r.json) as StoredSession);
  }

  /** Shared handle for the job store (same disposable database). */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

/** Merge the session-local files and the ledger into the record the UI renders. */
export function enrich(s: StoredSession, repo: Repo | null): StoredSession {
  const rounds = existsSync(s.worktreePath) ? (readRounds(s.worktreePath, s.id) as StoredRound[]) : [];
  const max = (repo?.config.thresholds.maxLoopRounds ?? 5) + (s.capRaised ? 5 : 0);
  const waitingFile = join(s.worktreePath, ".sdlc-state", "sessions", s.id, "waiting.json");
  let waiting: { reason: string } | null = null;
  if (existsSync(waitingFile)) {
    try {
      waiting = JSON.parse(readFileSync(waitingFile, "utf8")) as { reason: string };
    } catch {
      waiting = null;
    }
  }
  const files = repo?.changes.get(s.changeId);
  const mine = files ? files.events.filter((e) => e.actor.type === "agent" && e.actor.session === s.id) : [];
  const testEditAttempts = eventsNamed(mine, "hook.blocked").filter((e) => e.data.hook === "test-freeze").length;
  const verifier = eventsNamed(mine, "verifier.result").at(-1)?.data ?? null;
  const state = loopState(rounds, max);
  const draft = s.kind === "build" && existsSync(s.worktreePath) ? readReproDraft(s.worktreePath, s.id) : null;
  const committed = files?.change?.repro?.state === "committed";
  const repro = draft && !committed ? draft : null;
  const waitingOnYou = waiting
    ? { reason: waiting.reason }
    : repro && !repro.rejected
      ? { reason: "confirm the repro test — fails for the right reason?" }
      : state === "stalled"
        ? { reason: "loop not converging" }
        : s.status === "awaiting_engineer"
          ? { reason: "run the session command in your terminal" }
          : null;
  return {
    ...s,
    loop: { state, rounds: rounds.map((r) => ({ n: r.n, ts: r.ts, results: r.results, ...(r.screenshotRef ? { screenshotRef: r.screenshotRef } : {}), ...(r.diffPct !== undefined ? { diffPct: r.diffPct } : {}) })) },
    repro,
    waitingOnYou,
    testEditAttempts,
    verifier,
    status: s.status === "running" && waitingOnYou ? "waiting" : s.status,
  };
}

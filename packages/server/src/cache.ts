import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Snapshot } from "./snapshot.js";

/**
 * The disposable cache of one product (decisions P11, 3.2): one SQLite file
 * under the product's `.sdlc-state/` shared by every operator of the server
 * and by a restart — sessions, jobs, metric facts, webhook deliveries and the
 * last derived snapshot per tree. Delete the directory and everything here is
 * rebuilt from git; nothing in it is a lifecycle fact.
 */
export function cachePathFor(home: string): string {
  return join(home, ".sdlc-state", "sessions.db");
}

export function openCache(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export interface CachedSnapshot {
  key: string;
  snapshot: Snapshot;
  builtAt: string;
}

/**
 * Derived snapshot per tree key (`<head>|<artifact branches>`): a second
 * process (another operator's `sdlc serve`, a restart) serves the view the
 * last derivation produced until git moves, instead of deriving again.
 */
export class SnapshotCache {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, json TEXT NOT NULL, builtAt TEXT NOT NULL)");
  }

  get(key: string): CachedSnapshot | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT json, builtAt FROM snapshots WHERE key = ?").get(key) as { json: string; builtAt: string } | undefined;
    return row ? { key, snapshot: JSON.parse(row.json) as Snapshot, builtAt: row.builtAt } : null;
  }

  /** Keep the latest derivation only: the cache is a warm start, not a history. */
  put(key: string, snapshot: Snapshot): void {
    if (!this.db.open) return;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM snapshots WHERE key <> ?").run(key);
      this.db.prepare("INSERT OR REPLACE INTO snapshots (key, json, builtAt) VALUES (?, ?, ?)").run(key, JSON.stringify(snapshot), snapshot.generatedAt);
    });
    tx();
  }

  keys(): string[] {
    if (!this.db.open) return [];
    return (this.db.prepare("SELECT key FROM snapshots ORDER BY builtAt DESC").all() as { key: string }[]).map((r) => r.key);
  }
}

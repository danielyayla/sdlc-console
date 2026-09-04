import type Database from "better-sqlite3";
import type { GitHubPrFacts, GitHubStatusFacts } from "@sdlc/core";

interface Row {
  key: string;
  kind: string;
  json: string;
  fetchedAt: string;
}

/**
 * Cached external facts for the metrics (blueprint 7.11 "snapshot cache"):
 * GitHub reviews per PR head and commit statuses per head, in the disposable
 * `.sdlc-state` database. Rebuildable from the API; nothing here is a
 * lifecycle fact.
 */
export class FactsCache {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS metric_facts (key TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL, fetchedAt TEXT NOT NULL)");
  }

  putPr(f: GitHubPrFacts): void {
    this.db.prepare("INSERT OR REPLACE INTO metric_facts (key, kind, json, fetchedAt) VALUES (?, 'pr', ?, ?)").run(`pr:${f.number}:${f.headSha}`, JSON.stringify(f), f.fetchedAt);
  }

  putStatus(f: GitHubStatusFacts): void {
    this.db.prepare("INSERT OR REPLACE INTO metric_facts (key, kind, json, fetchedAt) VALUES (?, 'status', ?, ?)").run(`status:${f.headSha}`, JSON.stringify(f), f.fetchedAt);
  }

  pr(number: number, headSha: string): GitHubPrFacts | null {
    const row = this.db.prepare("SELECT json FROM metric_facts WHERE key = ?").get(`pr:${number}:${headSha}`) as Pick<Row, "json"> | undefined;
    return row ? (JSON.parse(row.json) as GitHubPrFacts) : null;
  }

  status(headSha: string): GitHubStatusFacts | null {
    const row = this.db.prepare("SELECT json FROM metric_facts WHERE key = ?").get(`status:${headSha}`) as Pick<Row, "json"> | undefined;
    return row ? (JSON.parse(row.json) as GitHubStatusFacts) : null;
  }

  prs(): GitHubPrFacts[] {
    return (this.db.prepare("SELECT json FROM metric_facts WHERE kind = 'pr' ORDER BY key").all() as Pick<Row, "json">[]).map((r) => JSON.parse(r.json) as GitHubPrFacts);
  }

  statuses(): GitHubStatusFacts[] {
    return (this.db.prepare("SELECT json FROM metric_facts WHERE kind = 'status' ORDER BY key").all() as Pick<Row, "json">[]).map((r) => JSON.parse(r.json) as GitHubStatusFacts);
  }

  /** Latest fetch time across the cache, or null when empty. */
  fetchedAt(): string | null {
    const row = this.db.prepare("SELECT MAX(fetchedAt) AS at FROM metric_facts").get() as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  clear(): void {
    this.db.exec("DELETE FROM metric_facts");
  }
}

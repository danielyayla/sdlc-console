import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "@sdlc/adapter-git";
import type { RoundLike } from "@sdlc/core";
import { readRounds, roundsFile } from "@sdlc/hooks";
import type { RoundResult } from "@sdlc/schemas";

export type LoopState = "not-run" | "iterating" | "green" | "stalled" | "flaky";

export interface StoredRound extends RoundLike {
  ts: string;
  results: RoundResult[];
  screenshotRef?: string;
  diffPct?: number;
  /** Fingerprint of uncommitted changes when the round ran; equal fingerprints mean no file changed. */
  dirtyHash: string;
}

export { readRounds, roundsFile };

export async function dirtyHash(root: string): Promise<string> {
  // code changes only: ledger appends and the session cache must not count as "a file changed"
  const excludes = [":(exclude)sdlc/changes", ":(exclude).sdlc-state"];
  const diff = await git(root, ["diff", "HEAD", "--stat", "--", ".", ...excludes]).catch(() => "");
  const status = await git(root, ["status", "--porcelain", "--", ".", ...excludes]).catch(() => "");
  return createHash("sha1").update(diff).update(status).digest("hex").slice(0, 12);
}

export function appendRound(root: string, session: string, round: StoredRound): void {
  const file = roundsFile(root, session);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(round)}\n`, "utf8");
}

/** Spec 5B.2: stalled when rounds exceed the cap or the same test fails 3 rounds; flaky when red→green with no file change. */
export function loopState(rounds: readonly StoredRound[], maxLoopRounds: number): LoopState {
  const last = rounds.at(-1);
  if (!last) return "not-run";
  const green = last.results.every((r) => r.pass);
  if (rounds.length > maxLoopRounds) return "stalled";
  const failing = rounds.slice(-3).map((r) => r.results.filter((x) => !x.pass).map((x) => x.name).sort().join(","));
  if (failing.length === 3 && failing[0] !== "" && failing.every((f) => f === failing[0])) return "stalled";
  const prev = rounds.at(-2);
  if (green && prev && !prev.results.every((r) => r.pass) && prev.dirtyHash === last.dirtyHash) return "flaky";
  return green ? "green" : "iterating";
}

export function waitingFile(root: string, session: string): string {
  return join(root, ".sdlc-state", "sessions", session, "waiting.json");
}

export function setWaiting(root: string, session: string, reason: string, now: string): void {
  const file = waitingFile(root, session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ reason, since: now })}\n`, "utf8");
}

export function clearWaiting(root: string, session: string): void {
  const file = waitingFile(root, session);
  if (existsSync(file)) rmSync(file);
}

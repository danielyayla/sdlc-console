import { stringifyFrontMatter, stringifyJson, type Bands, type BandTierNumber, type ControlBand, type MetricSnapshot, type Runbook, type RunbookRun, type Triage } from "@sdlc/schemas";
import { nextId } from "./ids.js";
import type { Repo } from "./repo.js";
import { refuse, type TransitionResult, type WritePlan } from "./writeplan.js";
import { SYSTEM_ACTOR } from "./transitions/context.js";

/**
 * Control bands (blueprint §4 Stage 06, FR-60; build-order 3.4). Everything
 * here is deterministic arithmetic over `bands.yaml` and the detection
 * snapshots: no model is involved in deciding a tier (P4).
 */

/** Snapshots per metric, oldest first. */
export type MetricSnapshots = Record<string, readonly MetricSnapshot[]>;

/** Sample standard deviation; null with fewer than two values. */
export function sampleSigma(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Minimum retained samples before the sample deviation stands in for a declared `sigma`. */
export const BASELINE_MIN_SAMPLES = 3;

/**
 * Tier of one sample against the band (Western Electric rule 1: a single
 * point beyond k·σ). Rules 2–4 (runs of points) are listed in `rules` but
 * not evaluated yet; the tier never exceeds 3.
 */
export function tierOf(current: number, baseline: number, sigma: number): BandTierNumber {
  if (!(sigma > 0)) return 0;
  const d = Math.abs(current - baseline) / sigma;
  return d >= 3 ? 3 : d >= 2 ? 2 : d >= 1 ? 1 : 0;
}

/** The deviation a band uses: declared, else the sample deviation of the retained values once enough are on file. */
export function sigmaFor(band: Pick<ControlBand, "sigma">, previous: readonly MetricSnapshot[]): number | null {
  if (band.sigma !== undefined) return band.sigma;
  const values = previous.map((s) => s.current).filter((v): v is number => v !== null);
  if (values.length < BASELINE_MIN_SAMPLES) return null;
  return sampleSigma(values);
}

/** Parse the last numeric token a source printed; null when there is none. */
export function parseMetricOutput(output: string): number | null {
  const tokens = output.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  const last = tokens?.at(-1);
  if (last === undefined) return null;
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

/** `30s`, `15m`, `1h` → milliseconds; null when unparseable. */
export function parseInterval(text: string | undefined): number | null {
  if (text === undefined) return null;
  const m = /^(\d+)(s|m|h)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n * (m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : 3_600_000);
}

export const DEFAULT_DETECT_EVERY = "15m";

export type BandAction = "log" | "diagnose" | "propose";

/** What the Bands table renders per band (spec §4.6): current, σ, tier, status text. */
export interface BandStatus {
  metric: string;
  baseline: number;
  unit: string | null;
  source: string | null;
  current: number | null;
  sigma: number | null;
  tier: BandTierNumber | null;
  breached: boolean;
  /** The tier's configured action; null at tier 0 or without data. */
  action: BandAction | null;
  /** Time of the latest snapshot; null without one. */
  ts: string | null;
  samples: number;
  /** One line for the STATUS cell, literal: what is known and since when. */
  status: string;
  /** Open triage items raised for this metric (`src: metric:<metric>`). */
  triage: string[];
  /** The job key of the latest breach, when a triage item records one. */
  job: string | null;
}

export function actionFor(band: ControlBand, tier: BandTierNumber | null): BandAction | null {
  if (tier === null || tier === 0) return null;
  return tier === 1 ? band.tiers["1sigma"].action : tier === 2 ? band.tiers["2sigma"].action : band.tiers["3sigma"].action;
}

export function bandStatus(bands: Bands | null, snapshots: MetricSnapshots, triage: readonly Pick<Triage, "id" | "src" | "status" | "job">[] = []): BandStatus[] {
  if (!bands) return [];
  return bands.metrics.map((band) => {
    const history = snapshots[band.metric] ?? [];
    const latest = history.at(-1) ?? null;
    const open = triage.filter((t) => t.src === `metric:${band.metric}` && t.status === "open");
    const job = open.map((t) => t.job ?? null).find((j) => j !== null) ?? null;
    const base = { metric: band.metric, baseline: band.baseline, unit: band.unit ?? null, source: band.source ?? null, samples: history.length, triage: open.map((t) => t.id), job };
    if (!band.source) return { ...base, current: null, sigma: band.sigma ?? null, tier: null, breached: false, action: null, ts: null, status: "no source · add `source:` to bands.yaml" };
    if (!latest) return { ...base, current: null, sigma: band.sigma ?? null, tier: null, breached: false, action: null, ts: null, status: "no data · detection has not run" };
    if (latest.current === null) return { ...base, current: null, sigma: latest.sigma, tier: null, breached: false, action: null, ts: latest.ts, status: `no data · since ${latest.ts} (source exit ${latest.source.exitCode})` };
    if (latest.sigma === null || latest.tier === null) return { ...base, current: latest.current, sigma: null, tier: null, breached: false, action: null, ts: latest.ts, status: `collecting baseline · ${history.filter((s) => s.current !== null).length}/${BASELINE_MIN_SAMPLES} samples` };
    const action = actionFor(band, latest.tier);
    const status = latest.tier === 0 ? `within 1σ · ${latest.ts}` : `${latest.tier}σ · ${action ?? ""}${open.length > 0 ? ` · ${open.map((t) => t.id).join(", ")}` : ""} · ${latest.ts}`;
    return { ...base, current: latest.current, sigma: latest.sigma, tier: latest.tier, breached: latest.breached, action, ts: latest.ts, status };
  });
}

/** Runbooks the allowlist can actually run: entries with a command. A bare id is listed but has no command. */
export function runbookById(bands: Bands | null, id: string): Runbook | null {
  for (const r of bands?.runbooks ?? []) if (typeof r !== "string" && r.id === id) return r;
  return null;
}

export function runbookListed(bands: Bands | null, id: string): boolean {
  return (bands?.runbooks ?? []).some((r) => (typeof r === "string" ? r : r.id) === id);
}

/** The routes a band's 3σ tier allows: `pr` and `runbook:<id>` entries. */
export function routesOf(band: ControlBand): { pr: boolean; runbooks: string[] } {
  const routes = band.tiers["3sigma"].routes;
  return { pr: routes.includes("pr"), runbooks: routes.filter((r) => r.startsWith("runbook:")).map((r) => r.slice("runbook:".length)) };
}

export interface BandBreach {
  band: ControlBand;
  snapshot: MetricSnapshot;
  /** The engine job that answers the breach. */
  job: string;
}

export function breachTitle(b: Pick<BandBreach, "band" | "snapshot">): string {
  const unit = b.band.unit ? ` ${b.band.unit}` : "";
  return `${b.band.metric} breached ${b.snapshot.tier ?? 0}σ: ${b.snapshot.current ?? "?"}${unit} vs baseline ${b.band.baseline}${unit}`;
}

/** The evidence a breach carries: the numbers, then the source's output verbatim. */
export function breachEvidence(b: Pick<BandBreach, "band" | "snapshot">): string {
  const s = b.snapshot;
  const head = `${s.metric} = ${s.current ?? "?"} at ${s.ts} · baseline ${s.baseline} · σ ${s.sigma ?? "?"} · tier ${s.tier ?? 0}σ (${((Math.abs((s.current ?? 0) - s.baseline)) / (s.sigma || 1)).toFixed(2)}σ)`;
  return `${head}\n--- ${s.source.command} (exit ${s.source.exitCode})\n${s.source.output.trimEnd()}\n`;
}

function breachBody(b: Pick<BandBreach, "band" | "snapshot">): string {
  const action = b.snapshot.tier === 3 ? "A propose job (3σ) may open a pull request into the review gate or trigger a pre-approved runbook; its findings replace this section when it ends." : "A diagnose job (2σ, read-only) is looking; its findings replace this section when it ends.";
  return `# Intent: ${breachTitle(b)}

## Problem
${b.band.metric} left its control band: ${b.snapshot.current ?? "?"} against a baseline of ${b.band.baseline} (σ ${b.snapshot.sigma ?? "?"}), ${b.snapshot.tier ?? 0}σ under the deterministic rule. ${action}

## Proposed outcome
${b.band.metric} back within 1σ of ${b.band.baseline}${b.band.unit ? ` ${b.band.unit}` : ""}, or the band tuned with a reason.

## Affected users and systems
Whatever ${b.band.metric} measures; see the evidence.

## Constraints
Detection stays deterministic; the tier action is whatever bands.yaml allows (${b.snapshot.tier === 3 ? b.band.tiers["3sigma"].routes.join(", ") : b.band.tiers["2sigma"].tools.join(", ")}).

## Open questions
What changed around ${b.snapshot.ts}?
`;
}

/** A breach is already on file while an open triage item cites the metric. */
export function openBreachItem(repo: Pick<Repo, "triage">, metric: string): Triage | null {
  return repo.triage.find((t) => t.data.src === `metric:${metric}` && t.data.status === "open")?.data ?? null;
}

/**
 * FR-61: band breaches become triage items, one per metric while it is open,
 * committed by sdlc-bot with the job key on the item. Deterministic: the
 * evidence is the source's output verbatim and the body a pre-drafted intent
 * the diagnose/propose job fills in when it ends.
 */
export function raiseBandBreaches(repo: Repo, breaches: readonly BandBreach[], ctx: { now: string }): TransitionResult & { raised?: { id: string; metric: string; job: string }[] } {
  const pending = breaches.filter((b) => (b.snapshot.tier ?? 0) >= 2 && !openBreachItem(repo, b.band.metric));
  if (pending.length === 0) return refuse("bands.no-breaches", "no new band breaches");
  const ids = repo.triage.map((t) => t.data.id);
  const files: WritePlan["files"] = [];
  const raised: { id: string; metric: string; job: string }[] = [];
  for (const b of pending) {
    const id = nextId("TRI", [...ids, ...raised.map((r) => r.id)]);
    raised.push({ id, metric: b.band.metric, job: b.job });
    const data: Triage = { schema: 1, id, tier: b.snapshot.tier === 3 ? "3σ" : "2σ", src: `metric:${b.band.metric}`, title: breachTitle(b), evidence: breachEvidence(b), createdAt: ctx.now, status: "open", job: b.job };
    files.push({ path: `sdlc/loop/triage/${id}.md`, content: stringifyFrontMatter(data as unknown as Record<string, unknown>, breachBody(b)) });
  }
  return {
    ok: true,
    raised,
    plan: {
      changeId: null,
      files,
      events: [],
      commitMessage: `sdlc(bands): ${raised.map((r) => `${r.id} ${r.metric}`).join(", ")} breached`,
      trailers: { "SDLC-Actor": `system:${SYSTEM_ACTOR.id}`, "SDLC-Job": pending.map((b) => b.job).join(" "), "SDLC-Snapshot": pending.map((b) => `${b.snapshot.metric}@${b.snapshot.ts}`).join(" ") },
      actor: SYSTEM_ACTOR,
    },
  };
}

/** What a diagnose/propose session reported through `report_diagnosis` (intent format, PB-S6 step 5). */
export interface Diagnosis {
  title: string;
  problem: string;
  proposedOutcome: string;
  affected: string;
  constraints?: string;
  openQuestions?: string;
}

export interface DiagnosisRecord {
  triageId: string;
  session: string;
  agent: string;
  diagnosis: Diagnosis | null;
  /** Runbook invocations the session made, in order; each becomes `sdlc/loop/runbooks/RBK-NNNN.json`. */
  runbookRuns: readonly Omit<RunbookRun, "schema" | "id">[];
  /** The branch a propose session committed to, with its pull request when one was opened. */
  proposal: { branch: string; head: string; pr?: { number: number; url: string } } | null;
  /** How the session ended, for the record when nothing else was reported. */
  outcome: string;
}

function diagnosisBody(r: DiagnosisRecord, d: Diagnosis): string {
  const runs = r.runbookRuns.length > 0 ? `\n\n## Runbooks run\n${r.runbookRuns.map((x) => `- ${x.runbook} (exit ${x.exitCode}) at ${x.finishedAt}`).join("\n")}` : "";
  const pr = r.proposal ? `\n\n## Proposed change\n${r.proposal.pr ? `PR #${r.proposal.pr.number} ${r.proposal.pr.url}` : `branch ${r.proposal.branch}`} at ${r.proposal.head.slice(0, 7)} — reviewed and merged by the code owner, never by the job.` : "";
  return `# Intent: ${d.title}

## Problem
${d.problem.trim()}

## Proposed outcome
${d.proposedOutcome.trim()}

## Affected users and systems
${d.affected.trim()}

## Constraints
${(d.constraints ?? "Detection stays deterministic; the diagnosis is the agent's reading of the evidence, judged by a human.").trim()}

## Open questions
${(d.openQuestions ?? "None recorded.").trim()}${runs}${pr}
`;
}

/**
 * A finished diagnose/propose session's output onto its triage item: the
 * diagnosis becomes the pre-drafted intent (title kept in sync), runbook
 * invocations become records, a proposal branch/PR is noted. The item's
 * evidence and `job` stay as detection wrote them; the actor is the agent
 * (recorded on the item as `session`), sdlc-bot commits.
 */
export function recordDiagnosis(repo: Repo, r: DiagnosisRecord): TransitionResult & { runbookIds?: string[] } {
  const item = repo.triage.find((t) => t.data.id === r.triageId);
  if (!item) return refuse("triage.missing", `${r.triageId} is not in the queue`);
  const files: WritePlan["files"] = [];
  const known = repo.runbookRuns.map((x) => x.id);
  const runbookIds: string[] = [];
  for (const run of r.runbookRuns) {
    const id = nextId("RBK", [...known, ...runbookIds]);
    runbookIds.push(id);
    const record: RunbookRun = { schema: 1, id, ...run, triage: r.triageId };
    files.push({ path: `sdlc/loop/runbooks/${id}.json`, content: stringifyJson(record) });
  }
  const changed = r.diagnosis !== null || r.runbookRuns.length > 0 || r.proposal !== null;
  if (!changed) return refuse("diagnosis.empty", `session ${r.session} reported nothing (${r.outcome})`);
  const data: Triage = { ...item.data, ...(r.diagnosis ? { title: r.diagnosis.title } : {}), session: r.session };
  const body = r.diagnosis ? diagnosisBody(r, r.diagnosis) : `${item.body.trimEnd()}\n\n## Session ${r.session}\n${r.outcome}${r.runbookRuns.length > 0 ? `\n\n## Runbooks run\n${r.runbookRuns.map((x) => `- ${x.runbook} (exit ${x.exitCode}) at ${x.finishedAt}`).join("\n")}` : ""}${r.proposal ? `\n\n## Proposed change\n${r.proposal.pr ? `PR #${r.proposal.pr.number} ${r.proposal.pr.url}` : `branch ${r.proposal.branch}`} at ${r.proposal.head.slice(0, 7)}` : ""}\n`;
  files.push({ path: item.path, content: stringifyFrontMatter(data as unknown as Record<string, unknown>, body) });
  return {
    ok: true,
    runbookIds,
    plan: {
      changeId: null,
      files,
      events: [],
      commitMessage: `sdlc(${r.triageId}): ${r.diagnosis ? "diagnosis" : "session record"} from ${r.session}${runbookIds.length > 0 ? ` · ${runbookIds.join(", ")}` : ""}${r.proposal?.pr ? ` · PR #${r.proposal.pr.number}` : r.proposal ? ` · ${r.proposal.branch}` : ""}`,
      trailers: { "SDLC-Actor": `agent:${r.agent}`, "SDLC-Session": r.session, ...(item.data.job ? { "SDLC-Job": item.data.job } : {}) },
      actor: { type: "agent", id: r.agent, session: r.session },
    },
  };
}

/** Where a `nextId("RBK")` allocation looks: committed records plus any the caller knows from other branches. */
export function nextRunbookId(existing: readonly RunbookRun[]): string {
  return nextId("RBK", existing.map((r) => r.id));
}

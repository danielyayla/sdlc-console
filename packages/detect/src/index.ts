/**
 * @sdlc/detect — the deterministic detection script (blueprint §4 Stage 06
 * "System (deterministic detection script)", FR-60; build-order 3.4).
 *
 * Runs every `source:` command declared in `bands.yaml`, keeps the output
 * verbatim, computes the σ tier with `@sdlc/core` and writes one snapshot
 * per metric under `.sdlc-state/snapshots/` — the cache the Bands table
 * reads. No model is involved; whoever runs it (CI, `sdlc detect`,
 * `sdlc serve --engine` on its schedule) gets the same answer for the same
 * output. Raising jobs from the tiers is the engine's part.
 */
export const PACKAGE_NAME = "@sdlc/detect" as const;

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionFor, bandStatus, parseMetricOutput, sigmaFor, tierOf, type BandAction, type BandStatus, type MetricSnapshots } from "@sdlc/core";
import { parseBands, validate, type Bands, type ControlBand, type Diagnostic, type MetricSnapshot } from "@sdlc/schemas";

export interface Exec {
  (cmd: string, cwd: string): Promise<{ exitCode: number; output: string }>;
}

function shell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode: code, output: `${stdout}${stderr ? `\n${stderr}` : ""}` });
    });
  });
}

/** Snapshots retained per metric (blueprint §12: "last N retained"). */
export const DEFAULT_RETAIN = 500;

export function snapshotsDir(home: string): string {
  return join(home, ".sdlc-state", "snapshots");
}

function fileFor(home: string, metric: string): string {
  return join(snapshotsDir(home), `${metric.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
}

/**
 * File-backed snapshot store, one JSONL per metric, oldest first. Cache: a
 * deleted directory loses no lifecycle fact (the triage item keeps the
 * evidence of a breach); the next pass starts collecting again.
 */
export function readSnapshots(home: string): MetricSnapshots {
  const dir = snapshotsDir(home);
  if (!existsSync(dir)) return {};
  const out: Record<string, MetricSnapshot[]> = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const r = validate("metric-snapshot", raw, name);
      if (!r.ok) continue;
      (out[r.value.metric] ??= []).push(r.value);
    }
  }
  return out;
}

export function appendSnapshot(home: string, snapshot: MetricSnapshot, retain = DEFAULT_RETAIN): void {
  mkdirSync(snapshotsDir(home), { recursive: true });
  const file = fileFor(home, snapshot.metric);
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "") : [];
  lines.push(JSON.stringify(snapshot));
  writeFileSync(file, `${lines.slice(-retain).join("\n")}\n`, "utf8");
}

export interface DetectionInput {
  /** The SDLC home whose `bands.yaml` and `.sdlc-state/` are used. */
  home: string;
  /** Parsed bands; read from `<home>/bands.yaml` when absent. */
  bands?: Bands | null;
  exec?: Exec;
  timeoutMs?: number;
  now?: () => Date;
  retain?: number;
  /** Where the sources run (default: the home). */
  cwd?: string;
}

export interface BandResult {
  band: ControlBand;
  snapshot: MetricSnapshot;
  /** Configured action for the tier; null at tier 0 or without data. */
  action: BandAction | null;
}

export interface DetectionPass {
  ts: string;
  results: BandResult[];
  /** Bands without a `source:`; nothing ran for them. */
  skipped: string[];
  /** The table as the console renders it, after this pass. */
  status: BandStatus[];
  diagnostics: Diagnostic[];
}

export function loadBands(home: string): { bands: Bands | null; diagnostics: Diagnostic[] } {
  const file = join(home, "bands.yaml");
  if (!existsSync(file)) return { bands: null, diagnostics: [] };
  const r = parseBands(readFileSync(file, "utf8"), "bands.yaml");
  return { bands: r.value, diagnostics: r.diagnostics };
}

/**
 * One detection pass: every band with a source is measured once, the tier
 * computed against its baseline and σ (declared, else the sample deviation
 * of the retained snapshots), the snapshot appended. A failing source is a
 * snapshot too (`current: null`) so the table can say "no data · since T".
 */
export async function runDetection(input: DetectionInput): Promise<DetectionPass> {
  const loaded = input.bands === undefined ? loadBands(input.home) : { bands: input.bands, diagnostics: [] as Diagnostic[] };
  const bands = loaded.bands;
  const ts = (input.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const exec = input.exec ?? ((c, d) => shell(c, d, input.timeoutMs ?? 5 * 60_000));
  const results: BandResult[] = [];
  const skipped: string[] = [];
  const history = readSnapshots(input.home);
  for (const band of bands?.metrics ?? []) {
    if (!band.source) {
      skipped.push(band.metric);
      continue;
    }
    const r = await exec(band.source, input.cwd ?? input.home);
    const current = r.exitCode === 0 ? parseMetricOutput(r.output) : null;
    const previous = history[band.metric] ?? [];
    const sigma = sigmaFor(band, previous);
    const tier = current === null || sigma === null ? null : tierOf(current, band.baseline, sigma);
    const snapshot: MetricSnapshot = { schema: 1, metric: band.metric, ts, baseline: band.baseline, current, sigma, tier, breached: tier !== null && tier >= 2, source: { command: band.source, exitCode: r.exitCode, output: r.output } };
    appendSnapshot(input.home, snapshot, input.retain ?? DEFAULT_RETAIN);
    history[band.metric] = [...previous, snapshot];
    results.push({ band, snapshot, action: actionFor(band, tier) });
  }
  return { ts, results, skipped, status: bandStatus(bands, history), diagnostics: loaded.diagnostics };
}

/** Human rendering of a pass: one line per band, then the sources' output verbatim for anything beyond 1σ or failed. */
export function renderDetection(pass: DetectionPass): string {
  const lines: string[] = [];
  for (const s of pass.status) lines.push(`${s.metric.padEnd(24)} baseline ${String(s.baseline).padStart(8)}  current ${String(s.current ?? "—").padStart(8)}  σ ${s.sigma === null ? "—" : s.sigma.toFixed(2)}  tier ${s.tier === null ? "—" : `${s.tier}σ`}  ${s.status}`);
  for (const r of pass.results) {
    if (r.snapshot.current !== null && (r.snapshot.tier ?? 0) < 2) continue;
    lines.push(`--- ${r.band.metric}: ${r.snapshot.source.command} (exit ${r.snapshot.source.exitCode})`);
    lines.push(r.snapshot.source.output.trimEnd());
  }
  for (const d of pass.diagnostics) lines.push(`${d.severity}: ${d.message}`);
  if (pass.status.length === 0) lines.push("no bands.yaml");
  return lines.join("\n");
}

/** Exit code for scripts and CI: 2 when a band is at 2σ or beyond, 1 when a source failed or bands.yaml did not parse, 0 otherwise. */
export function exitCodeFor(pass: DetectionPass): 0 | 1 | 2 {
  if (pass.results.some((r) => (r.snapshot.tier ?? 0) >= 2)) return 2;
  if (pass.results.some((r) => r.snapshot.current === null) || pass.diagnostics.some((d) => d.severity === "error")) return 1;
  return 0;
}

export interface DetectIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

/** `sdlc-detect [--root <dir>] [--json]`: the script's entry point; `sdlc detect` calls the same function on the resolved home. */
export async function detectMain(argv: string[], io: DetectIo, exec?: Exec): Promise<number> {
  let root = io.cwd;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--root" && argv[i + 1]) root = join(io.cwd, argv[++i] ?? "");
    else if (a === "--help" || a === "-h") {
      io.stdout("sdlc-detect [--root <dir>] [--json]   run the bands.yaml sources once, write .sdlc-state/snapshots, print the table (exit 2 at ≥2σ, 1 on a failed source)\n");
      return 0;
    } else {
      io.stderr(`unknown argument ${a ?? ""}\n`);
      return 1;
    }
  }
  const pass = await runDetection({ home: root, ...(exec ? { exec } : {}) });
  io.stdout(json ? `${JSON.stringify(pass, null, 2)}\n` : `${renderDetection(pass)}\n`);
  return exitCodeFor(pass);
}

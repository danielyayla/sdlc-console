import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_NAME, appendSnapshot, detectMain, exitCodeFor, readSnapshots, renderDetection, runDetection, snapshotsDir, type Exec } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const BANDS = `detectEvery: 30s
metrics:
  - metric: p95_latency_ms
    baseline: 310
    unit: ms
    sigma: 40
    source: "scripts/p95.sh"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep] }
      3sigma: { action: propose, routes: [pr] }
  - metric: error_rate_pct
    baseline: 0.4
    source: "scripts/errors.sh"
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read] }
      3sigma: { action: propose, routes: [] }
  - metric: queue_depth
    baseline: 12
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read] }
      3sigma: { action: propose, routes: [] }
`;

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-detect-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bands.yaml"), BANDS);
  return dir;
}

describe("@sdlc/detect: the deterministic detection script", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/detect");
  });

  it("runs every source once, keeps the output verbatim, computes the tier and appends a snapshot per metric; bands without a source are skipped", async () => {
    const dir = home();
    const calls: string[] = [];
    const exec: Exec = (cmd, cwd) => {
      calls.push(`${cmd}@${cwd === dir ? "home" : cwd}`);
      return Promise.resolve(cmd.includes("p95") ? { exitCode: 0, output: "export p95 (ms)\n842\n" } : { exitCode: 0, output: "0.45" });
    };
    const pass = await runDetection({ home: dir, exec, now: () => new Date("2026-09-08T10:00:00Z") });
    expect(calls).toEqual(["scripts/p95.sh@home", "scripts/errors.sh@home"]);
    expect(pass.skipped).toEqual(["queue_depth"]);
    expect(pass.results.map((r) => [r.band.metric, r.snapshot.current, r.snapshot.sigma, r.snapshot.tier, r.snapshot.breached, r.action])).toEqual([
      ["p95_latency_ms", 842, 40, 3, true, "propose"],
      ["error_rate_pct", 0.45, null, null, false, null],
    ]);
    expect(pass.results[0]?.snapshot.source).toEqual({ command: "scripts/p95.sh", exitCode: 0, output: "export p95 (ms)\n842\n" });
    const stored = readSnapshots(dir);
    expect(Object.keys(stored).sort()).toEqual(["error_rate_pct", "p95_latency_ms"]);
    expect(stored["p95_latency_ms"]?.[0]).toEqual(pass.results[0]?.snapshot);
    expect(existsSync(join(snapshotsDir(dir), "p95_latency_ms.jsonl"))).toBe(true);
    expect(pass.status.map((s) => s.status)).toEqual(["3σ · propose · 2026-09-08T10:00:00Z", "collecting baseline · 1/3 samples", "no source · add `source:` to bands.yaml"]);
    expect(exitCodeFor(pass)).toBe(2);
    const text = renderDetection(pass);
    expect(text).toContain("p95_latency_ms");
    expect(text).toContain("--- p95_latency_ms: scripts/p95.sh (exit 0)\nexport p95 (ms)\n842");
    expect(text).not.toContain("--- error_rate_pct"); // within band / collecting: no evidence dump
  });

  it("a failing source is a snapshot with no value (exit 1 for the script); the sample deviation takes over after three samples; retention keeps the last N", async () => {
    const dir = home();
    let n = 0;
    const values = [0.4, 0.42, 0.38, 0.41, 0.9];
    const exec: Exec = (cmd) => {
      if (cmd.includes("p95")) return Promise.resolve({ exitCode: 7, output: "curl: (7) connection refused" });
      return Promise.resolve({ exitCode: 0, output: String(values[n++] ?? 0.4) });
    };
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 8, 8, 10, t++ * 15));
    const first = await runDetection({ home: dir, exec, now, retain: 3 });
    expect(first.results[0]?.snapshot).toMatchObject({ current: null, tier: null, breached: false, source: { exitCode: 7, output: "curl: (7) connection refused" } });
    expect(first.status[0]?.status).toBe("no data · since 2026-09-08T10:00:00Z (source exit 7)");
    expect(exitCodeFor(first)).toBe(1);
    await runDetection({ home: dir, exec, now, retain: 3 });
    await runDetection({ home: dir, exec, now, retain: 3 });
    const fourth = await runDetection({ home: dir, exec, now, retain: 3 });
    // σ from the three retained samples (0.4, 0.42, 0.38 → 0.02); 0.41 is within 1σ
    expect(fourth.results[1]?.snapshot.sigma?.toFixed(3)).toBe("0.020");
    expect(fourth.results[1]?.snapshot.tier).toBe(0);
    const fifth = await runDetection({ home: dir, exec, now, retain: 3 });
    expect(fifth.results[1]?.snapshot.tier).toBe(3);
    expect(readSnapshots(dir)["error_rate_pct"]).toHaveLength(3);
    expect(readSnapshots(dir)["error_rate_pct"]?.map((s) => s.current)).toEqual([0.38, 0.41, 0.9]);
  });

  it("readSnapshots ignores malformed lines and files that are not snapshots; appendSnapshot creates the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-detect-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(readSnapshots(dir)).toEqual({});
    appendSnapshot(dir, { schema: 1, metric: "m", ts: "2026-09-08T10:00:00Z", baseline: 1, current: 1, sigma: 1, tier: 0, breached: false, source: { command: "x", exitCode: 0, output: "1" } });
    mkdirSync(snapshotsDir(dir), { recursive: true });
    writeFileSync(join(snapshotsDir(dir), "m.jsonl"), `${readFileSync(join(snapshotsDir(dir), "m.jsonl"), "utf8")}not json\n{"schema":1,"metric":"m"}\n`);
    expect(readSnapshots(dir)["m"]).toHaveLength(1);
  });

  it("sdlc-detect: --json prints the pass, the exit code carries the verdict, unknown flags are refused", async () => {
    const dir = home();
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), cwd: dir };
    const exec: Exec = () => Promise.resolve({ exitCode: 0, output: "320" });
    expect(await detectMain(["--json"], io, exec)).toBe(0);
    const pass = JSON.parse(out.join("")) as { results: { snapshot: { tier: number | null } }[] };
    expect(pass.results.map((r) => r.snapshot.tier)).toEqual([0, null]);
    expect(await detectMain(["--bogus"], io, exec)).toBe(1);
    expect(err.join("")).toContain("unknown argument --bogus");
    const empty = mkdtempSync(join(tmpdir(), "sdlc-detect-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    out.length = 0;
    expect(await detectMain([], { ...io, cwd: empty }, exec)).toBe(0);
    expect(out.join("")).toContain("no bands.yaml");
  });
});

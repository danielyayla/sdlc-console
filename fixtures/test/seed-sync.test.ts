import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { seedDir, seedFiles, seedSessions } from "../src/index.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

describe("fixtures/seed is the generator's output", () => {
  it("has exactly the generated files with identical content (run pnpm --filter @sdlc/fixtures generate)", () => {
    const expected = seedFiles();
    const dir = seedDir();
    const onDisk = walk(dir).map((abs) => relative(dir, abs).split("\\").join("/")).sort();
    expect(onDisk).toEqual(Object.keys(expected).sort());
    for (const rel of onDisk) expect(readFileSync(join(dir, rel), "utf8"), rel).toBe(expected[rel]);
  });
  it("is deterministic", () => {
    expect(seedFiles()).toEqual(seedFiles());
  });
  it("ships four sessions", () => {
    expect(seedSessions().map((s) => s.mode)).toEqual(["SUPERVISED", "PLAN", "PLAN", "HEADLESS"]);
  });
  it("ships one design mock (CHG-0018) and two visual rounds on its build session", () => {
    expect(Object.keys(seedFiles()).filter((p) => p.includes("/design/"))).toEqual(["sdlc/changes/CHG-0018/design/export-dialog.svg"]);
    const build = seedSessions().find((s) => s.id === "sess-0018-repro") as { loop: { rounds: { n: number; diffPct?: number; screenshotRef?: string }[] } } | undefined;
    expect(build?.loop.rounds.map((r) => [r.n, r.diffPct, r.screenshotRef])).toEqual([
      [1, 14.2, ".sdlc-state/sessions/sess-0018-repro/screenshots/round-1.png"],
      [2, 3.1, ".sdlc-state/sessions/sess-0018-repro/screenshots/round-2.png"],
    ]);
  });
});

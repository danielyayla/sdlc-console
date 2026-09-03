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
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { main, type Io } from "@sdlc/cli";
import { ENG, PO, writeSeed } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function sdlc(dir: string, args: string[], identity = PO): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdin: () => Promise.resolve(""), env: { SDLC_IDENTITY: identity }, cwd: dir };
  const code = await main(args, io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("the seed in a real git repository", () => {
  it("validates clean, audits clean, and runs (a) and (b) through the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-seed-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
    await git(dir, ["config", "commit.gpgsign", "false"]);
    writeSeed(dir);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);

    const validate = await sdlc(dir, ["validate", "--json"]);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.out).blocking).toBe(false);

    for (const id of ["CHG-0012", "CHG-0017", "CHG-0018", "CHG-0019", "CHG-0020", "CHG-0021", "CHG-0022"]) {
      const audit = await sdlc(dir, ["audit", id, "--json"]);
      const report = JSON.parse(audit.out) as { clean: boolean; breaks: string[] };
      // seed decisions were not committed one-by-one, so decision commits are not individually traceable
      expect(report.breaks.filter((b) => !b.includes("SDLC-Event trailer")), id).toEqual([]);
    }

    const a = await sdlc(dir, ["accept", "CHG-0022", "--gate", "1", "--json"]);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out).view.stage).toBe(2);
    const auditA = await sdlc(dir, ["audit", "CHG-0022"]);
    expect(auditA.out).toContain("accepted intent.md (gate 1) ←");

    const asEng = await sdlc(dir, ["accept", "CHG-0012", "--gate", "6"], ENG);
    expect(asEng.code).toBe(2);
    const b = await sdlc(dir, ["loop", "CHG-0012", "--json"]);
    expect(b.code).toBe(0);
    expect(JSON.parse(b.out)).toMatchObject({ cycle: 2, view: { stage: 1, status: "Loop closed — re-entered Plan from incident" } });
    const tree = await git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "sdlc/changes/CHG-0012"]);
    expect(tree).toContain("sdlc/changes/CHG-0012/cycles/1/incident.md");
    const validateAfter = await sdlc(dir, ["validate", "--json"]);
    expect(JSON.parse(validateAfter.out).blocking).toBe(false);
  }, 30_000);
});

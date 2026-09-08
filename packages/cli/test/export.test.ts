import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { verifyChangeExport } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import type { ChangeExport } from "@sdlc/schemas";
import { main, type Io } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function makeIo(dir: string, env: Record<string, string> = {}): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdin: () => Promise.resolve(""), env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }, cwd: dir };
  return { io, out, err };
}

async function sdlc(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const { io, out, err } = makeIo(dir, env);
  const code = await main(args, io);
  return { code, out: out.join(""), err: err.join("") };
}

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-cli-export-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

describe("sdlc export <CHG> (3.3)", () => {
  it("prints the hashed JSON document, resolves the commit of a decision made through the CLI, and writes Markdown with --out; agents may run it", async () => {
    const dir = await seeded();
    // a decision made here has a commit with the SDLC-Event trailer: the export names it
    const accept = await sdlc(dir, ["accept", "CHG-0022", "--gate", "1"]);
    expect(accept.code).toBe(0);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();

    const r = await sdlc(dir, ["export", "CHG-0022"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as ChangeExport;
    expect(doc.kind).toBe("change-export");
    expect(verifyChangeExport(doc)).toBe(true);
    expect(doc.exportedBy).toEqual({ id: PO, name: "Priya Owens" });
    expect(doc.ref).toBe(head);
    const decision = doc.cycles[0]?.decisions.find((d) => d.gate === 1);
    expect(decision).toMatchObject({ decision: "accepted", by: { id: PO, role: "po" }, source: "cli", commit: head });
    expect(doc.derived.acceptedGates).toEqual([1]);

    // --json is the same document; SDLC_IDENTITY names the exporter
    const j = await sdlc(dir, ["export", "CHG-0022", "--json"], { SDLC_IDENTITY: "auditor@veri.example" });
    expect(j.code).toBe(0);
    expect((JSON.parse(j.out) as ChangeExport).exportedBy).toEqual({ id: "auditor@veri.example" });

    // Markdown to a file
    const out = join(dir, "exports", "CHG-0022.md");
    const m = await sdlc(dir, ["export", "CHG-0022", "--format", "md", "--out", out]);
    expect(m.code).toBe(0);
    expect(m.out).toContain(`wrote ${out}`);
    expect(m.out).toContain(`sha256 ${doc.contentHash.value.slice(0, 8)}`);
    expect(existsSync(out)).toBe(true);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("# Compliance export · CHG-0022");
    expect(md).toContain(`| 1 | accepted | ${PO} | po | cli |`);
    expect(md).toContain(head.slice(0, 7));

    // read-only: an agent process gets the same document (nothing is granted by exporting)
    const agent = await sdlc(dir, ["export", "CHG-0022", "--json"], { SDLC_ACTOR_TYPE: "agent" });
    expect(agent.code).toBe(0);
    expect((JSON.parse(agent.out) as ChangeExport).contentHash.value).toMatch(/^[0-9a-f]{64}$/);

    // an older ref exports what that ref said
    const before = await sdlc(dir, ["export", "CHG-0022", "--ref", "HEAD~1"]);
    expect((JSON.parse(before.out) as ChangeExport).derived.acceptedGates).toEqual([]);

    expect((await sdlc(dir, ["export", "CHG-9999"])).code).toBe(1);
    expect((await sdlc(dir, ["export", "CHG-0022", "--format", "pdf"])).code).toBe(1);
    expect((await sdlc(dir, ["export"])).code).toBe(1);
  }, 30_000);
});

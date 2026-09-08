import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { PO, writeMonorepoSeed, writeSeed } from "@sdlc/fixtures";
import type { RunningServer } from "@sdlc/server";
import { main } from "../src/main.js";
import type { Io } from "../src/io.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Run {
  code: number;
  out: string;
  err: string;
  json: <T>() => T;
}

async function sdlc(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdin: () => Promise.resolve(""), env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }, cwd };
  const code = await main(args, io);
  const o = out.join("");
  return { code, out: o, err: err.join(""), json: <T,>() => JSON.parse(o) as T };
}

async function repo(prefix: string, seed: (dir: string) => void): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  seed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

describe("products on the CLI (3.2)", () => {
  it("a monorepo root that lists several products refuses to guess; --product, SDLC_PRODUCT or the product's directory picks one", async () => {
    const dir = await repo("sdlc-cli-mono-", (d) => writeMonorepoSeed(d));
    const ambiguous = await sdlc(dir, ["change", "list"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("lists 2 products (invoicing, billing); pass --product <name>");
    const byFlag = await sdlc(dir, ["change", "list", "--product", "billing", "--json"]);
    expect(byFlag.code).toBe(0);
    expect(byFlag.json<{ id: string }[]>()).toHaveLength(8);
    const byEnv = await sdlc(dir, ["change", "list", "--json"], { SDLC_PRODUCT: "billing" });
    expect(byEnv.code).toBe(0);
    const inside = await sdlc(join(dir, "apps/billing"), ["change", "list", "--json"]);
    expect(inside.code).toBe(0);
    const unknown = await sdlc(dir, ["change", "list", "--product", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no product named nope");
    // a decision addressed to a product commits under its home
    const accepted = await sdlc(dir, ["accept", "CHG-0022", "--gate", "1", "--product", "billing", "--json"]);
    expect(accepted.code).toBe(0);
    const touched = (await git(dir, ["show", "--stat", "--format=", "HEAD"])).trim();
    expect(touched).toContain("apps/billing/sdlc/changes/CHG-0022/");
    expect((await sdlc(dir, ["change", "show", "CHG-0022", "--product", "invoicing", "--json"])).json<{ stage: number }>().stage).toBe(1);
    expect((await sdlc(dir, ["change", "show", "CHG-0022", "--product", "billing", "--json"])).json<{ stage: number }>().stage).toBe(2);
  });

  it("a single-product repository needs no flag, and --product on it names nothing", async () => {
    const dir = await repo("sdlc-cli-single-", (d) => writeSeed(d));
    expect((await sdlc(dir, ["change", "list", "--json"])).code).toBe(0);
    expect((await sdlc(dir, ["change", "list", "--product", "invoicing", "--json"])).code).toBe(0);
    const nope = await sdlc(dir, ["change", "list", "--product", "billing"]);
    expect(nope.code).toBe(1);
    expect(nope.err).toContain("no product named billing; ");
  });

  it("sdlc serve --repo serves another repository next to the working directory and names the products", async () => {
    const dir = await repo("sdlc-cli-serve-", (d) => writeMonorepoSeed(d));
    const other = await repo("sdlc-cli-serve2-", (d) => writeMonorepoSeed(d, [{ name: "website", path: "site" }]));
    // the other repository's root product is also "invoicing": served twice it would clash, so only its nested product is unique
    const clash = await sdlc(dir, ["serve", "--port", "0", "--repo", other]);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("two products are named invoicing");
    const { serveCommand } = await import("../src/commands/serve.js");
    const out: string[] = [];
    const io: Io = { stdout: (t) => out.push(t), stderr: () => undefined, stdin: () => Promise.resolve(""), env: { PATH: process.env["PATH"] ?? "" }, cwd: join(other, "site") };
    // served from inside the nested product: that product plus the first repository's two
    const server: RunningServer = await serveCommand(io, { port: 0, repos: [dir] });
    cleanups.push(() => server.close());
    expect(server.products.map((p) => p.name)).toEqual(["website", "invoicing", "billing"]);
    expect(out.join("")).toContain("products: website, invoicing, billing");
  }, 20_000);
});

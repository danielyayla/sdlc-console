import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitWritePlan, git, homeFor, initRepo, mergeBranch, readTree, showPrefix } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function monorepo(): Promise<string> {
  // git reports real paths; macOS's tmpdir is a symlink
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdlc-home-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: "po@veri.example", name: "Priya" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  for (const home of ["", "apps/billing"]) {
    mkdirSync(join(dir, home, "sdlc"), { recursive: true });
    writeFileSync(join(dir, home, "sdlc", "config.yaml"), "schema: 1\ndefaultRole: po\nidentities:\n  - id: po@veri.example\n    roles: [po]\n");
  }
  mkdirSync(join(dir, "apps/billing/src"), { recursive: true });
  writeFileSync(join(dir, "apps/billing/src/index.ts"), "export {};\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

describe("SDLC home resolution (3.2, monorepo products)", () => {
  it("resolves the root for a single-product repository and the nearest sdlc/ home inside a product directory", async () => {
    const dir = await monorepo();
    expect(await homeFor(dir)).toEqual({ root: dir, home: dir, prefix: "" });
    // inside the product (even a subdirectory without its own sdlc/) the product's home wins
    expect(await homeFor(join(dir, "apps/billing/src"))).toEqual({ root: dir, home: join(dir, "apps/billing"), prefix: "apps/billing/" });
    // a directory with no home between it and the root resolves to the root
    mkdirSync(join(dir, "apps/other"), { recursive: true });
    expect((await homeFor(join(dir, "apps/other"))).home).toBe(dir);
    expect(await showPrefix(join(dir, "apps/billing"))).toBe("apps/billing/");
    expect(await showPrefix(dir)).toBe("");
  });

  it("SDLC_HOME (relative to the root, or absolute) names the home explicitly — what the launcher hands a product's sessions", async () => {
    const dir = await monorepo();
    expect((await homeFor(dir, { SDLC_HOME: "apps/billing" })).home).toBe(join(dir, "apps/billing"));
    expect((await homeFor(join(dir, "apps/billing"), { SDLC_HOME: join(dir, "apps/billing") })).prefix).toBe("apps/billing/");
  });

  it("a product's tree reads and commits relative to its home: paths are sdlc/… inside the home, apps/billing/sdlc/… in the repository", async () => {
    const dir = await monorepo();
    const home = join(dir, "apps/billing");
    const tree = await readTree(home, "HEAD");
    expect([...tree.files.keys()]).toEqual(["sdlc/config.yaml"]);
    const sha = await commitWritePlan(home, { changeId: null, files: [{ path: "sdlc/changes/CHG-0001/intent.md", content: "# Intent\n" }], events: [], commitMessage: "sdlc(CHG-0001): intent", trailers: {}, actor: { type: "human", id: "po@veri.example" } }, { identity: { id: "po@veri.example", name: "Priya" } });
    expect((await git(dir, ["show", "--stat", "--format=", sha])).trim()).toContain("apps/billing/sdlc/changes/CHG-0001/intent.md");
    expect((await readTree(dir, "HEAD")).files.has("sdlc/changes/CHG-0001/intent.md")).toBe(false);
    expect((await readTree(home, "HEAD")).files.has("sdlc/changes/CHG-0001/intent.md")).toBe(true);
  });
});

describe("on-behalf-of commits (3.2, GitHub App as committer)", () => {
  it("commitWritePlan and mergeBranch take a committer distinct from the author; without one the author commits", async () => {
    const dir = await monorepo();
    const person = { id: "po@veri.example", name: "Priya Owens" };
    const app = { id: "94242+sdlc-console[bot]@users.noreply.github.com", name: "sdlc-console[bot]" };
    const sha = await commitWritePlan(dir, { changeId: null, files: [{ path: "sdlc/changes/CHG-0001/intent.md", content: "# Intent\n" }], events: [], commitMessage: "sdlc(CHG-0001): accept intent", trailers: {}, actor: { type: "human", id: person.id } }, { identity: person, committer: app });
    expect((await git(dir, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", sha])).trim()).toBe("Priya Owens <po@veri.example>|sdlc-console[bot] <94242+sdlc-console[bot]@users.noreply.github.com>");
    const plain = await commitWritePlan(dir, { changeId: null, files: [{ path: "sdlc/changes/CHG-0001/spec.md", content: "# Spec\n" }], events: [], commitMessage: "sdlc(CHG-0001): spec", trailers: {}, actor: { type: "human", id: person.id } }, { identity: person });
    expect((await git(dir, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", plain])).trim()).toBe("Priya Owens <po@veri.example>|Priya Owens <po@veri.example>");

    await git(dir, ["branch", "feature", "HEAD~1"]);
    await git(dir, ["checkout", "-q", "feature"]);
    writeFileSync(join(dir, "f.txt"), "f\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "feature"]);
    await git(dir, ["checkout", "-q", "main"]);
    const merge = await mergeBranch(dir, "feature", "merge feature", person, app);
    expect((await git(dir, ["show", "-s", "--format=%an|%cn", merge])).trim()).toBe("Priya Owens|sdlc-console[bot]");
  });
});

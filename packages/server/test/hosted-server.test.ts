import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo } from "@sdlc/adapter-git";
import { gitHubCodeHostFrom } from "@sdlc/adapter-github";
import { PO, realizeSeedRepro, writeSeed } from "@sdlc/fixtures";
import { appendFinding } from "@sdlc/mcp";
import { Engine, JobStore, SessionRegistry, StateStore, acceptGate, launchSession, newChange, startServer, type Exec } from "../src/index.js";
import { startFakeGitHub, type FakeApp, type FakeGitHub } from "../../adapters/github/test/fake-github.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const PRIYA = { id: PO, name: "Priya Owens" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const APP: FakeApp = { id: 4242, slug: "sdlc-console", installationId: 77, publicKey: pair.publicKey };
const BOT = { name: "sdlc-console[bot]", id: "94242+sdlc-console[bot]@users.noreply.github.com" };

/** Seed repo in GitHub mode with a bare `origin` and a fake API that has the App installed. */
async function appSeed(): Promise<{ dir: string; gh: FakeGitHub; env: Record<string, string> }> {
  const base = mkdtempSync(join(tmpdir(), "sdlc-hosted-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "clone");
  mkdirSync(dir);
  await initRepo(dir, "main", PRIYA);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  const cfg = join(dir, "sdlc/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("codeHost: local", "codeHost: github"));
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  const bare = join(base, "origin.git");
  await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "origin", "main"]);
  const gh = await startFakeGitHub({ bare, owner: "acme", repo: "widgets", protected: true, app: APP });
  cleanups.push(() => gh.close());
  const env = { SDLC_GITHUB_APP_ID: String(APP.id), SDLC_GITHUB_APP_INSTALLATION_ID: String(APP.installationId), SDLC_GITHUB_APP_PRIVATE_KEY: pair.privateKey, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets" };
  return { dir, gh, env };
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });

/** The hosted server's shape in miniature: one store committing on behalf of people (the App as committer), the engine as the server identity. */
async function harness(dir: string, env: Record<string, string>) {
  const host = gitHubCodeHostFrom(env);
  if (!host) throw new Error("no host");
  const committer = await host.appIdentity();
  if (!committer) throw new Error("no app identity");
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, committer, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE, exec: green, autoLaunch: false, env, syncIntervalMs: 3_600_000, now: () => new Date("2026-09-08T09:00:00Z") });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine, committer };
}

async function buildAndRun(dir: string, env: Record<string, string>) {
  const h = await harness(dir, env);
  await h.store.refresh();
  await h.engine.sync();
  const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
  const wt = launched.session.worktreePath;
  await realizeSeedRepro(dir, wt);
  mkdirSync(join(wt, "src/export"), { recursive: true });
  writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
  h.registry.patch(launched.session.id, { status: "done" });
  const job = await h.engine.runForSession({ ...launched.session, status: "done" });
  return { ...h, job, session: launched.session, worktree: wt };
}

const authorCommitter = async (dir: string, ref: string) => (await git(dir, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", ref])).trim();

describe("hosted mode under a GitHub App (3.2): check runs replace commit statuses", () => {
  it("the green run publishes check runs with the evidence verbatim, opens sdlc/findings in progress, and never posts a commit status; every call carries the installation token", async () => {
    const { dir, gh, env } = await appSeed();
    const h = await buildAndRun(dir, env);
    expect(h.job?.state).toBe("done");
    expect(h.job?.note).toContain("PR opened");
    const pushed = (await git(gh.bare, ["rev-parse", "refs/heads/CHG-0018/export-fix"])).trim();

    expect(gh.state.statuses).toEqual([]);
    const runs = gh.state.checkRuns.filter((r) => r.head_sha === pushed);
    expect(runs.map((r) => [r.name, r.status, r.conclusion])).toEqual([
      ["sdlc/findings", "in_progress", null],
      ["sdlc/repro", "completed", "success"],
      ["sdlc/evals", "completed", "success"],
      ["sdlc/evidence", "completed", "success"],
    ]);
    const evidence = runs.find((r) => r.name === "sdlc/evidence");
    expect(String(evidence?.output["title"])).toContain("green");
    // the command output, verbatim — not a summary of it
    expect(String(evidence?.output["text"])).toContain("(exit 0)\nTests 45 passed (45)");
    expect(evidence?.details_url).toBe("https://github.example/acme/widgets/pull/1");
    expect(String(runs.find((r) => r.name === "sdlc/findings")?.output["title"])).toBe("review pending");

    // the PAT is never used: repo calls bear the installation token minted once from the App JWT
    const repoCalls = gh.state.requests.filter((r) => r.path.startsWith("/repos/"));
    expect(repoCalls.length).toBeGreaterThan(3);
    expect(repoCalls.every((r) => r.auth?.startsWith("Bearer ghs_"))).toBe(true);
    expect(gh.state.installationTokens).toHaveLength(1);
    expect(gh.state.requests.filter((r) => r.path.endsWith("/access_tokens"))).toHaveLength(1);

    // the review completes the findings run in place — one run, updated, with the findings verbatim in its text
    const review = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE_CLAUDE });
    appendFinding(h.worktree, review.session.id, { n: 1, ts: "2026-09-08T09:05:00Z", severity: "high", title: "export drops rows whose amount is 0", path: "src/export/csv.ts", detail: "rows.filter(Boolean) removes { amount: 0 }" });
    h.registry.patch(review.session.id, { status: "done" });
    const mirrored = await h.engine.mirrorForSession({ ...review.session, status: "done" });
    expect(mirrored?.state).toBe("done");
    const findings = gh.state.checkRuns.filter((r) => r.name === "sdlc/findings" && r.head_sha === pushed);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(String(findings[0]?.output["title"])).toBe(`review of ${pushed.slice(0, 7)}: 1 high · 0 medium · 0 low`);
    expect(String(findings[0]?.output["text"])).toContain("- **high** export drops rows whose amount is 0 — `src/export/csv.ts`");
    expect(String(findings[0]?.output["text"])).toContain("rows.filter(Boolean) removes { amount: 0 }");
    // findings inform: the review posted is a COMMENT, nothing approved
    expect(gh.state.reviews.map((r) => r.body["event"])).toEqual(["COMMENT"]);
    expect(gh.state.statuses).toEqual([]);
  }, 40_000);

  it("gate 5 merges through the API as the App, and the decision commits are authored by the person and committed by the App's bot user", async () => {
    const { dir, gh, env } = await appSeed();
    const h = await buildAndRun(dir, env);
    expect(h.job?.state).toBe("done");
    expect(h.committer).toEqual(BOT);
    const r = await acceptGate(h.store, "CHG-0018", 5, env);
    expect(r.toast).toContain("Maintain");
    expect(gh.state.pulls[0]).toMatchObject({ merged: true, merged_by: "sdlc-console[bot]" });
    // the gate.accepted commit: author Eli, committer the App — "on behalf of", never impersonating
    expect(await authorCommitter(dir, r.commit)).toBe("Eli Ng <eng@veri.example>|sdlc-console[bot] <94242+sdlc-console[bot]@users.noreply.github.com>");
    // the local sync merge of origin/main after the API merge carries the same authorship split
    const sync = (await git(dir, ["log", "--format=%H|%s", "--merges", "-1", "main"])).trim();
    expect(sync).toContain("sync origin/main");
    expect(await authorCommitter(dir, sync.split("|")[0] ?? "")).toBe("Eli Ng <eng@veri.example>|sdlc-console[bot] <94242+sdlc-console[bot]@users.noreply.github.com>");
    // the engine's own records (the run file, pr.yaml) stay sdlc-bot's: nothing is attributed to a person who did not decide
    const runCommit = (await git(dir, ["log", "--format=%H", "--grep=per-change run", "-1", "main"])).trim();
    expect(await authorCommitter(dir, runCommit)).toBe("sdlc-bot <sdlc-bot@sdlc.local>|sdlc-bot <sdlc-bot@sdlc.local>");
  }, 40_000);

  it("an artifact PR accepted by a signed-in viewer (store.as) is committed on the PR branch as that person with the App as committer, then merged by the App", async () => {
    const { dir, gh, env } = await appSeed();
    const h = await harness(dir, env);
    await h.store.refresh();
    await h.engine.sync();
    const intentBody = "# Intent: Dunning reminders\n\n## Problem\nOverdue invoices are chased by hand.\n\n## Proposed outcome\nA reminder schedule per customer.\n\n## Affected users and systems\nFinance; the invoicing service.\n\n## Constraints\nNo third-party mail provider.\n\n## Open questions\nNone.\n";
    const created = await newChange(h.store.as(PRIYA), { title: "Dunning reminders", kind: "feature", risk: "routine", origin: { type: "idea" }, intentBody });
    const id = created.changeId ?? "";
    expect(await authorCommitter(dir, created.commit)).toBe("Priya Owens <po@veri.example>|sdlc-console[bot] <94242+sdlc-console[bot]@users.noreply.github.com>");
    const synced = await h.engine.sync();
    expect(synced?.opened.map((o) => [o.changeId, o.artifact])).toEqual([[id, 0]]);
    const accepted = await acceptGate(h.store.as(PRIYA), id, 1, env);
    expect(accepted.toast).toContain("PR #");
    expect(await authorCommitter(dir, accepted.commit)).toBe("Priya Owens <po@veri.example>|sdlc-console[bot] <94242+sdlc-console[bot]@users.noreply.github.com>");
    const pull = gh.state.pulls.find((p) => p.head === `sdlc/${id}/intent`);
    expect(pull).toMatchObject({ merged: true, merged_by: "sdlc-console[bot]" });
    const snap = await h.store.refresh(true);
    expect(snap.changes.find((c) => c.id === id)?.stage).toBe(2);
    // the decision on record is Priya's (gate.accepted, human), source pr.merge
    const accepts = snap.changes.find((c) => c.id === id)?.activity.filter((a) => a.event === "gate.accepted") ?? [];
    expect(accepts.map((a) => a.actor)).toEqual(["human"]);
  }, 40_000);

  it("sdlc serve resolves the App's bot user as the product's committer; token mode and local mode have none", async () => {
    const { dir, env } = await appSeed();
    const hosted = await startServer({ cwd: dir, identity: ENG, env, sdlcBin: "/opt/sdlc/bin.js", claudeBin: FAKE_CLAUDE, watch: false });
    cleanups.push(() => hosted.close());
    expect(hosted.products.map((p) => [p.name, p.committer])).toEqual([["invoicing", BOT]]);
    expect(hosted.store.committer).toEqual(BOT);
    // /api/products says which product and code host a viewer is looking at
    const listed = (await (await fetch(`${hosted.url}/api/products`)).json()) as { current: string; products: { name: string; codeHost: string; primary: boolean }[] };
    expect(listed).toMatchObject({ current: "invoicing", products: [{ name: "invoicing", codeHost: "github", primary: true }] });
    await hosted.close();
    const token = await startServer({ cwd: dir, identity: ENG, env: { GITHUB_TOKEN: "ghp_test", GITHUB_API_URL: env["GITHUB_API_URL"] ?? "", GITHUB_REPOSITORY: "acme/widgets" }, watch: false });
    cleanups.push(() => token.close());
    expect(token.store.committer).toBeNull();
  }, 30_000);
});

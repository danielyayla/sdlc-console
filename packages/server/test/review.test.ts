import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { deriveChange, loadRepo } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { appendFinding } from "@sdlc/mcp";
import { ActionError, Engine, JobStore, SessionRegistry, StateStore, launchSession, type Exec } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-review-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

async function viewOf(dir: string, id: string) {
  const repo = loadRepo(await readTree(dir, "HEAD"));
  const files = repo.changes.get(id);
  if (!files) throw new Error(id);
  return deriveChange(repo, files);
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: cmd.includes("test") ? "Tests 45 passed (45)" : `${cmd}: ok` });

function harness(dir: string, autoLaunch = false) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch, now: () => new Date("2026-09-04T09:00:00Z") });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

/** CHG-0018 to stage 5 in local mode: a build session's commit, then the per-change run opens the local PR. */
async function toStage5(dir: string, autoLaunch = false) {
  const h = harness(dir, autoLaunch);
  await h.store.refresh();
  const launched = await launchSession({ changeId: "CHG-0018", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
  const wt = launched.session.worktreePath;
  mkdirSync(join(wt, "src/export"), { recursive: true });
  writeFileSync(join(wt, "src/export/csv.ts"), "export const fixed = true;\n");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "sdlc(CHG-0018): remove truthiness filter"]);
  h.registry.patch(launched.session.id, { status: "done" });
  const job = await h.engine.runForSession({ ...launched.session, status: "done" });
  if (job?.state !== "done") throw new Error(`run: ${job?.error ?? job?.state}`);
  return { ...h, worktree: wt, head: (await git(wt, ["rev-parse", "HEAD"])).trim() };
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("review findings mirror (2.3, local mode)", () => {
  it("a review session's findings become review.finding events with the agent as actor, the tally, a findings check and the reviewed head on pr.yaml — committed by sdlc-bot on main", async () => {
    const dir = await seeded();
    const h = await toStage5(dir);
    const before = await viewOf(dir, "CHG-0018");
    expect(before.stage).toBe(5);
    expect(before.pr?.checks.map((c) => [c.name, c.verdict])).toEqual([["evidence", "pass"], ["evals", "pass"], ["repro", "fail"]]); // the seed's repro sha is a placeholder: no proof in this clone (2.7)
    expect(before.pr?.review).toBeUndefined();
    expect(before.findings).toEqual([]);

    const review = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
    expect(review.session.kind).toBe("review");
    expect(review.session.worktreePath).toBe(h.worktree);
    // the PR branch did not move: the session's own ledger line went to main
    expect((await git(h.worktree, ["rev-parse", "HEAD"])).trim()).toBe(h.head);
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe(`sdlc(CHG-0018): session ${review.session.id} started (SUPERVISED)`);

    appendFinding(h.worktree, review.session.id, { n: 1, ts: "2026-09-04T09:05:00Z", severity: "medium", title: "export skips the header when the sheet is empty", path: "src/export/csv.ts" });
    appendFinding(h.worktree, review.session.id, { n: 2, ts: "2026-09-04T09:06:00Z", severity: "high", title: "zero-total rows are still filtered", path: "src/export/csv.ts", detail: "filter(Boolean) on line 3" });
    appendFinding(h.worktree, review.session.id, { n: 3, ts: "2026-09-04T09:07:00Z", severity: "low", title: "comment says 'truthy' — stale" });
    h.registry.patch(review.session.id, { status: "done" });
    const job = await h.engine.mirrorForSession({ ...review.session, status: "done" });
    expect(job?.state).toBe("done");
    expect(job?.note).toBe(`review of ${h.head.slice(0, 7)}: 1 high · 1 medium · 1 low`);

    const view = await viewOf(dir, "CHG-0018");
    expect(view.stage).toBe(5);
    expect(view.pr?.findings).toEqual({ high: 1, medium: 1, low: 1 });
    expect(view.pr?.checks.map((c) => [c.name, c.verdict])).toEqual([["evidence", "pass"], ["evals", "pass"], ["repro", "fail"], ["findings", "fail"]]);
    expect(view.pr?.review).toEqual({ session: review.session.id, headSha: h.head, at: "2026-09-04T09:00:00Z" });
    expect(view.pr?.headSha).toBe(h.head);
    // most severe first, then in reported order
    expect(view.findings.map((f) => [f.severity, f.title])).toEqual([
      ["high", "zero-total rows are still filtered"],
      ["medium", "export skips the header when the sheet is empty"],
      ["low", "comment says 'truthy' — stale"],
    ]);
    expect(view.findings[0]).toMatchObject({ path: "src/export/csv.ts", detail: "filter(Boolean) on line 3", session: review.session.id });
    const feed = view.activity.filter((a) => a.event === "review.finding");
    expect(feed.map((a) => a.text)).toEqual(["review finding (low): comment says 'truthy' — stale", "review finding (high): zero-total rows are still filtered", "review finding (medium): export skips the header when the sheet is empty"]);
    expect(feed.every((a) => a.actor === "agent")).toBe(true);
    const last = (await git(dir, ["log", "-1", "--format=%s%n%an <%ae>%n%(trailers:key=SDLC-Actor,valueonly)"])).trim().split("\n");
    expect(last[0]).toBe(`sdlc(CHG-0018): review of ${h.head.slice(0, 7)} · 3 findings (1 high, 1 medium, 1 low)`);
    expect(last[1]).toBe("sdlc-bot <sdlc-bot@sdlc.local>");
    expect(last[2]).toBe("system:sdlc-bot");
    expect(h.registry.get(review.session.id)?.reviewed).toBe(true);
  }, 30_000);

  it("a review session needs stage 5 with an open PR whose branch is in the clone; a review of a head that moved is refused, not recorded", async () => {
    const dir = await seeded();
    const h = harness(dir);
    await h.store.refresh();
    // CHG-0018 is at stage 4: no PR yet
    const early = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE }).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(ActionError);
    expect((early as ActionError).message).toContain("stage 5");
    // CHG-0017 (seed, Deploy) has pr.yaml but its branch was never in this clone
    const missing = await launchSession({ changeId: "CHG-0017", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ActionError);
    expect((missing as ActionError).message).toContain("not in this clone");

    const s5 = await toStage5(dir);
    const review = await launchSession({ changeId: "CHG-0018", kind: "review", mode: "SUPERVISED" }, { root: dir, registry: s5.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
    // a commit lands on the PR branch after the run: the review looked at a head the run never tested
    writeFileSync(join(s5.worktree, "src/export/late.ts"), "export const late = 1;\n");
    await git(s5.worktree, ["add", "-A"]);
    await git(s5.worktree, ["commit", "-q", "-m", "late"]);
    appendFinding(s5.worktree, review.session.id, { n: 1, ts: "2026-09-04T09:05:00Z", severity: "low", title: "late" });
    s5.registry.patch(review.session.id, { status: "done" });
    const job = await s5.engine.mirrorForSession({ ...review.session, status: "done" });
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("run the per-change run again");
    const view = await viewOf(dir, "CHG-0018");
    expect(view.pr?.review).toBeUndefined();
    expect(view.findings).toEqual([]);
  }, 30_000);

  it("with autoLaunch the engine starts one headless review per PR head and mirrors it when the harness ends; a later tick does not launch again", async () => {
    const dir = await seeded();
    const s5 = await toStage5(dir);
    // a second engine over the same clone and session registry, this one launching on its own
    const h = { ...harness(dir, true), head: s5.head };
    await h.store.refresh(true);
    await h.engine.tick();
    await waitFor(() => h.jobs.list().some((j) => j.kind === "review-mirror" && j.state !== "running"));
    const reviews = h.jobs.list().filter((j) => j.kind === "review" && j.changeId === "CHG-0018");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.key).toBe(`CHG-0018:1:5:review:${h.head.slice(0, 12)}`);
    const session = h.registry.list().find((s) => s.id === reviews[0]?.sessionId);
    expect(session?.kind).toBe("review");
    expect(session?.mode).toBe("HEADLESS");
    expect(session?.status).toBe("done");
    const mirror = h.jobs.list().find((j) => j.kind === "review-mirror");
    expect(mirror?.state).toBe("done");
    expect(mirror?.note).toBe(`review of ${h.head.slice(0, 7)}: 0 high · 0 medium · 0 low`);
    const view = await viewOf(dir, "CHG-0018");
    expect(view.pr?.review).toMatchObject({ session: session?.id, headSha: h.head });
    expect(view.pr?.findings).toEqual({ high: 0, medium: 0, low: 0 });
    expect(view.pr?.checks.at(-1)).toEqual({ name: "findings", verdict: "pass" });
    expect(view.findings).toEqual([]);
    // the reviewed head is in git, so a fresh tick (or a restart) has nothing to launch
    await h.store.refresh(true);
    await h.engine.tick();
    await new Promise((r) => setTimeout(r, 500));
    expect(h.jobs.list().filter((j) => j.kind === "review" && j.changeId === "CHG-0018")).toHaveLength(1);
    cleanups.push(() => new Promise((r) => setTimeout(r, 300)));
  }, 30_000);
});

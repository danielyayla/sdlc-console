import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initRepo, readTree } from "@sdlc/adapter-git";
import { loadRepo, pendingRepeatSignals, proposalViews, repeatSignals } from "@sdlc/core";
import { PO, writeSeed } from "@sdlc/fixtures";
import { writeProposalDraft } from "@sdlc/mcp";
import { ActionError, Engine, JobStore, SessionRegistry, StateStore, acceptProposalAction, launchSession, type Exec } from "../src/index.js";
import { startFakeGitHub } from "../../adapters/github/test/fake-github.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.sh", import.meta.url));
const ENG = { id: "eng@veri.example", name: "Eli Ng" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seeded(dir = mkdtempSync(join(tmpdir(), "sdlc-proposals-"))): Promise<string> {
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await initRepo(dir, "main", { id: PO, name: "Priya Owens" });
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeSeed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "sdlc(repo): seed"]);
  return dir;
}

const green: Exec = (cmd) => Promise.resolve({ exitCode: 0, output: `${cmd}: ok` });

function harness(dir: string, autoLaunch: boolean, env: Record<string, string> = {}) {
  const registry = new SessionRegistry(dir);
  cleanups.push(() => registry.close());
  const store = new StateStore({ root: dir, identity: ENG, sessions: () => registry.list() });
  const jobs = new JobStore(registry.database);
  const engine = new Engine({ store, registry, jobs, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE, exec: green, autoLaunch, env, syncIntervalMs: 3_600_000, now: () => new Date("2026-09-04T09:00:00Z") });
  cleanups.push(() => engine.close());
  return { registry, store, jobs, engine };
}

/** A second "test freeze active" block, from another session on another change: the seed's single block becomes a repeat. */
async function secondFreezeBlock(dir: string, changeId = "CHG-0019", session = "sess-0019-build", ts = "2026-09-03T10:00:00Z", id = "01J8ZPRPTESTEVENT000000001"): Promise<void> {
  const line = JSON.stringify({ schema: 1, id, ts, seq: 99, cycle: 1, actor: { type: "agent", id: "claude-code", session }, event: "hook.blocked", data: { hook: "test-freeze", reason: "Test freeze active", path: "test/payments/newco.test.ts" } });
  appendFileSync(join(dir, `sdlc/changes/${changeId}/log.jsonl`), `${line}\n`);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", `sdlc(${changeId}): hook block`]);
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function repoAt(dir: string) {
  return loadRepo(await readTree(dir, "HEAD"));
}

describe("CLAUDE.md proposals (2.8, FR-43): repeat signal → propose session → proposal file", () => {
  it("the engine launches one keyed propose job per pending reason on the newest cited change; the session reads the cluster and CLAUDE.md, commits nothing, and a session that files nothing is mirrored as skipped", async () => {
    const dir = await seeded();
    await secondFreezeBlock(dir);
    const repo = await repoAt(dir);
    expect(pendingRepeatSignals(repo).map((s) => [s.reason, s.count, s.citations])).toEqual([["test freeze active", 2, ["CHG-0018", "CHG-0019"]]]);
    const h = harness(dir, true);
    await h.store.refresh(true);
    const mainBefore = (await git(dir, ["rev-parse", "main"])).trim();
    await h.engine.tick();
    await waitFor(() => h.jobs.list().some((j) => j.kind === "proposal-mirror" && j.state !== "running"));
    const launched = h.jobs.list().filter((j) => j.kind === "claude-md-proposal");
    expect(launched).toHaveLength(1);
    expect(launched[0]?.key).toMatch(/^proposal:[0-9a-f]{8}$/);
    expect(launched[0]?.changeId).toBe("CHG-0019");
    const session = h.registry.get(launched[0]?.sessionId ?? "");
    expect(session).toMatchObject({ kind: "propose", mode: "HEADLESS", changeId: "CHG-0019", branch: "sdlc/propose/CHG-0019", status: "done" });
    const prompt = readFileSync(join(session?.worktreePath ?? "", ".sdlc-state", "sessions", session?.id ?? "", "prompt.md"), "utf8");
    expect(prompt).toContain('the same mistake was made 2 times across sessions — reason: "test freeze active"');
    expect(prompt).toContain("CHG-0018 · cycle 1 · hook test-freeze blocked · session sess-0018-repro");
    expect(prompt).toContain("CHG-0019 · cycle 1 · hook test-freeze blocked · session sess-0019-build");
    expect(prompt).toContain("one page is 600");
    expect(prompt).toContain("mcp__sdlc__propose_claude_md_line");
    expect(prompt).toContain("Make the same mistake twice → add a line here"); // CLAUDE.md verbatim
    const context = JSON.parse(readFileSync(join(session?.worktreePath ?? "", ".sdlc-state", "sessions", session?.id ?? "", "context.json"), "utf8")) as { job: string; allowedTools: string[] };
    expect(context.job).toBe("claude-md-proposal");
    expect(context.allowedTools).toEqual(["Read", "Grep", "Glob", "mcp__sdlc__get_change", "mcp__sdlc__propose_claude_md_line", "mcp__sdlc__log_note"]);
    // the throwaway branch carries no commit; the session's own lines went to main
    expect((await git(dir, ["rev-list", "main..sdlc/propose/CHG-0019"])).trim()).toBe("");
    expect((await git(dir, ["rev-parse", "main"])).trim()).not.toBe(mainBefore);
    // the stop line is committed by the observer as the harness exits; under load it can land a moment after the mirror job closes
    const sessionLines = async () => (await repoAt(dir)).changes.get("CHG-0019")?.events.filter((e) => (e.event === "session.started" || e.event === "session.stopped") && e.data.session === session?.id).map((e) => e.event) ?? [];
    for (let i = 0; i < 50 && (await sessionLines()).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await sessionLines()).toEqual(["session.started", "session.stopped"]);
    const after = await repoAt(dir);
    // the fake harness never called the tool: nothing filed, the job says so, and the reason stays pending for a human or a real session
    const mirror = h.jobs.list().find((j) => j.kind === "proposal-mirror");
    expect(mirror?.state).toBe("skipped");
    expect(mirror?.note).toBe(`session ${session?.id} ended without proposing a line`);
    expect(after.proposals.map((p) => p.id)).toEqual(["PRP-0007", "PRP-0008"]);
    // a later tick launches nothing new: the key is claimed
    await h.store.refresh(true);
    await h.engine.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.jobs.list().filter((j) => j.kind === "claude-md-proposal")).toHaveLength(1);
    // every harness the engine spawned has exited before the clone is removed
    await waitFor(() => h.registry.list().every((s) => s.status !== "running") && h.jobs.list().every((j) => j.state !== "running"));
    cleanups.push(() => new Promise((r) => setTimeout(r, 300)));
  }, 30_000);

  it("a drafted line is filed as sdlc/proposals/PRP-NNNN.yaml by sdlc-bot with a note under the agent's name; a third occurrence counts onto it and files nothing; a second session's draft for the same reason is skipped", async () => {
    const dir = await seeded();
    await secondFreezeBlock(dir);
    const h = harness(dir, false);
    await h.store.refresh(true);
    const r = await launchSession({ changeId: "CHG-0019", kind: "propose", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE });
    expect(r.session.kind).toBe("propose");
    writeProposalDraft(r.session.worktreePath, r.session.id, { text: "Under a repro freeze never edit a test; propose the change with mcp__sdlc__request_input.", citations: ["CHG-0018", "CHG-0019"], reason: "test freeze active", ts: "2026-09-04T09:05:00Z" });
    h.registry.patch(r.session.id, { status: "done" });
    const job = await h.engine.fileProposalForSession({ ...r.session, status: "done" });
    expect(job?.state).toBe("done");
    expect(job?.note).toBe('PRP-0009 filed for "test freeze active": Under a repro freeze never edit a test; propose the change with mcp__sdlc__request_input.');
    const after = await repoAt(dir);
    const filed = after.proposals.find((p) => p.id === "PRP-0009");
    expect(filed).toMatchObject({ type: "claude-md-line", status: "open", reason: "test freeze active", citations: ["CHG-0018", "CHG-0019"], createdAt: "2026-09-04T09:00:00Z" });
    const last = (await git(dir, ["log", "-1", "--format=%s%n%an <%ae>%n%(trailers:key=SDLC-Actor,valueonly)%n%(trailers:key=SDLC-Session,valueonly)"])).trim().split("\n").filter((l) => l !== "");
    expect(last[0]).toBe("sdlc(PRP-0009): propose CLAUDE.md line — Under a repro freeze never edit a test; propose the change with mcp__sdlc__request_input.");
    expect(last[1]).toBe("sdlc-bot <sdlc-bot@sdlc.local>");
    expect(last[2]).toBe("system:sdlc-bot");
    expect(last[3]).toBe(r.session.id);
    const note = after.changes.get("CHG-0018")?.events.find((e) => e.event === "note" && e.data.text.includes("PRP-0009"));
    expect(note?.actor).toEqual({ type: "agent", id: "claude-code@sdlc.local", session: r.session.id });
    expect(repeatSignals(after).find((s) => s.reason === "test freeze active")?.proposal).toEqual({ id: "PRP-0009", status: "open" });
    expect(pendingRepeatSignals(after)).toEqual([]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).not.toContain("Under a repro freeze");
    // a third occurrence: the count grows on PRP-0009, nothing pending, the engine launches nothing
    await secondFreezeBlock(dir, "CHG-0020", "sess-0020-build", "2026-09-04T11:00:00Z", "01J8ZPRPTESTEVENT000000002");
    const third = await repoAt(dir);
    expect(proposalViews(third).find((p) => p.id === "PRP-0009")?.seen).toBe(3);
    expect(pendingRepeatSignals(third)).toEqual([]);
    const auto = harness(dir, true);
    await auto.store.refresh(true);
    await auto.engine.tick();
    await waitFor(() => auto.registry.list().every((s) => s.status !== "running") && auto.jobs.list().every((j) => j.state !== "running"));
    expect(auto.jobs.list().filter((j) => j.kind === "claude-md-proposal")).toHaveLength(0);
    cleanups.push(() => new Promise((r2) => setTimeout(r2, 300)));
    // a second draft for the answered reason is not filed
    const again = await launchSession({ changeId: "CHG-0019", kind: "propose", mode: "SUPERVISED", reason: "test freeze active" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ActionError);
    expect((again as ActionError).message).toContain("PRP-0009 (open) already answers");
    writeProposalDraft(r.session.worktreePath, "sess-dup", { text: "another", citations: ["CHG-0019"], reason: "test freeze active", ts: "2026-09-04T09:06:00Z" });
    const dup = await h.engine.fileProposalForSession({ ...r.session, id: "sess-dup", status: "done" });
    expect(dup?.state).toBe("skipped");
    expect(dup?.note).toContain("PRP-0009 (open) already answers");
    expect((await repoAt(dir)).proposals.map((p) => p.id)).toEqual(["PRP-0007", "PRP-0008", "PRP-0009"]);
    // no propose session without a repeat reason
    const none = await launchSession({ changeId: "CHG-0021", kind: "propose", mode: "SUPERVISED" }, { root: dir, registry: h.registry, sdlcBin: "/opt/sdlc/bin.js", identity: ENG, claudeBin: FAKE }).catch((e: unknown) => e);
    expect((none as ActionError).message).toContain("no repeat reason cites CHG-0021");
  }, 30_000);
});

describe("accepting a proposal (2.8): the line goes on a branch for the code owners, never on the default branch", () => {
  it("local mode: eng accepts → branch sdlc/proposals/<PRP> with the line under the human's identity, proposal accepted with the branch, main's CLAUDE.md untouched; merged by hand → landed; PO and a second accept refused", async () => {
    const dir = await seeded();
    const h = harness(dir, false);
    await h.store.refresh();
    const po = new StateStore({ root: dir, identity: { id: PO, name: "Priya Owens" } });
    const refused = await acceptProposalAction(po, "PRP-0008").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).status).toBe(403);
    const missing = await acceptProposalAction(h.store, "PRP-0042").catch((e: unknown) => e);
    expect((missing as ActionError).status).toBe(404);

    const r = await acceptProposalAction(h.store, "PRP-0008");
    expect(r.toast).toBe("PRP-0008 accepted — branch sdlc/proposals/PRP-0008 carries the line — open a PR from it for the code owners");
    const branchMd = await git(dir, ["show", "sdlc/proposals/PRP-0008:CLAUDE.md"]);
    expect(branchMd).toContain("- Run the verification commands before reporting done; paste output verbatim.\n- Before committing, check every touched path against plan.md's \"Files that change\"; add a new path to plan.md in the same commit.\n\n## Commands");
    expect(await git(dir, ["show", "main:CLAUDE.md"])).not.toContain("Before committing, check every touched path");
    expect((await git(dir, ["log", "-1", "--format=%s%n%an <%ae>%n%(trailers:key=SDLC-Proposal,valueonly)", "sdlc/proposals/PRP-0008"])).trim().split("\n")).toEqual(["sdlc(PRP-0008): CLAUDE.md — Before committing, check every touched path against plan.md's \"Files that change\"; add a new path to plan.md in the same commit.", "Eli Ng <eng@veri.example>", "PRP-0008"]);
    expect((await git(dir, ["diff", "--name-only", "main...sdlc/proposals/PRP-0008"])).trim()).toBe("CLAUDE.md");
    expect((await git(dir, ["log", "-1", "--format=%s", "main"])).trim()).toBe("sdlc(PRP-0008): accept — CLAUDE.md line in review on sdlc/proposals/PRP-0008");
    const view = r.snapshot.proposalViews.find((p) => p.id === "PRP-0008");
    expect(view).toMatchObject({ status: "accepted", pr: { branch: "sdlc/proposals/PRP-0008" }, landed: false, seen: 2 });
    expect(r.snapshot.repeatSignals[0]?.proposal).toEqual({ id: "PRP-0008", status: "accepted" });
    const twice = await acceptProposalAction(h.store, "PRP-0008").catch((e: unknown) => e);
    expect((twice as ActionError).status).toBe(409);
    expect((twice as ActionError).message).toContain("PRP-0008 is accepted");
    // the code owners merge the branch (here: by hand) → the default branch carries the line
    await git(dir, ["merge", "-q", "--no-ff", "-m", "merge CLAUDE.md line", "sdlc/proposals/PRP-0008"]);
    const snap = await h.store.refresh(true);
    expect(snap.proposalViews.find((p) => p.id === "PRP-0008")?.landed).toBe(true);
    // the seed's hand-filed PRP-0007 (no reason) accepts too, its line placed in the same list
    const other = await acceptProposalAction(h.store, "PRP-0007");
    expect(other.snapshot.proposalViews.find((p) => p.id === "PRP-0007")).toMatchObject({ status: "accepted", seen: 0, landed: false });
    expect(await git(dir, ["show", "sdlc/proposals/PRP-0007:CLAUDE.md"])).toContain("- Never filter invoice rows by truthiness of the total; zero is a valid amount.\n\n## Commands");
  }, 30_000);

  it("GitHub mode: accept pushes the branch and opens the PR for the code owners; the proposal records number and url; nothing is merged; a retry reuses the commit", async () => {
    const base = mkdtempSync(join(tmpdir(), "sdlc-proposals-gh-"));
    const dir = join(base, "clone");
    mkdirSync(dir);
    await seeded(dir);
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const cfg = join(dir, "sdlc/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("codeHost: local", "codeHost: github"));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "github mode"]);
    const bare = join(base, "origin.git");
    await git(base, ["init", "-q", "--bare", "-b", "main", bare]);
    await git(dir, ["remote", "add", "origin", bare]);
    await git(dir, ["push", "-q", "origin", "main"]);
    const gh = await startFakeGitHub({ bare, owner: "acme", repo: "widgets", protected: true });
    cleanups.push(() => gh.close());
    const env = { GITHUB_TOKEN: gh.token, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "acme/widgets" };
    const h = harness(dir, false, env);
    await h.store.refresh();
    const noToken = await acceptProposalAction(h.store, "PRP-0008", {}).catch((e: unknown) => e);
    expect((noToken as ActionError).message).toContain("GITHUB_TOKEN is not set; the line is committed on sdlc/proposals/PRP-0008");
    expect((await repoAt(dir)).proposals.find((p) => p.id === "PRP-0008")?.status).toBe("open");
    const headBefore = (await git(dir, ["rev-parse", "sdlc/proposals/PRP-0008"])).trim();
    const r = await acceptProposalAction(h.store, "PRP-0008", env);
    expect(r.toast).toBe("PRP-0008 accepted — PR #1 opened for the code owners");
    expect((await git(dir, ["rev-parse", "sdlc/proposals/PRP-0008"])).trim()).toBe(headBefore);
    const pull = gh.state.pulls[0];
    expect(pull).toMatchObject({ number: 1, head: "sdlc/proposals/PRP-0008", base: "main", state: "open", merged: false });
    expect(pull?.title).toBe("sdlc(PRP-0008): CLAUDE.md — Before committing, check every touched path against plan.…");
    expect(pull?.body).toContain("The code owners of CLAUDE.md decide by merging; the console never merges configuration.");
    expect(pull?.body).toContain("Repeat reason: commit touches files outside plan.md's file list");
    expect((await git(dir, ["rev-parse", "origin/sdlc/proposals/PRP-0008"])).trim()).toBe(headBefore);
    const filed = (await repoAt(dir)).proposals.find((p) => p.id === "PRP-0008");
    expect(filed?.pr).toEqual({ branch: "sdlc/proposals/PRP-0008", number: 1, url: "https://github.example/acme/widgets/pull/1" });
    expect(r.snapshot.proposalViews.find((p) => p.id === "PRP-0008")?.landed).toBe(false);
    expect(await git(dir, ["show", "origin/main:CLAUDE.md"])).not.toContain("Before committing");
  }, 30_000);
});

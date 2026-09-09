import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { validate, type Deploy } from "@sdlc/schemas";
import { ROLLBACK_CHECK, applyWritePlan, badges, check, deriveChange, finishDeployment, gateQueues, loadRepo, recordDeployment, recordRehearsal, recordSessionDeploys, rollbackRehearsedCheck, startDeployment, validateTree, validateWritePlan, withFiles, type TransitionContext, type Tree, type WritePlan } from "../src/index.js";
import { AGENT, ENG, SHA, acceptedThrough, baseTree, ev, resetSeq, viewOf, withChange } from "./helpers.js";

const GOLDEN = fileURLToPath(new URL("./golden/CHG-0001.deploy.json", import.meta.url));
const HEAD = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const MERGE = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const OTHER = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

let n = 0;
const ctxFor = (actorId: string, now = "2026-09-08T10:00:00Z"): TransitionContext => ({
  now,
  newId: () => `01J8Z6Q7Y2K3M4N5P6Q7R8S${(++n).toString(36).toUpperCase().padStart(3, "0")}`.replace(/[ILOU]/g, "X"),
  actor: { id: actorId },
});

/** The base tree with two environments: staging (agent-deployable) and production behind a `release` gate. */
function envTree(): Tree {
  return withFiles(baseTree(), {
    "sdlc/config.yaml": `schema: 1
defaultRole: po
identities:
  - { id: po@example.com, roles: [po] }
  - { id: eng@example.com, roles: [eng, tech_lead] }
  - { id: release@example.com, roles: [release] }
  - { id: ops@example.com, roles: [po, release] }
thresholds: { autoFilesMax: 3 }
environments:
  - { name: staging, kind: staging, deploy: { command: "echo deploy staging" }, rollback: { command: "echo rollback staging" }, healthcheck: { command: "curl staging/health" } }
  - { name: production, kind: production, deploy: { command: "echo deploy production" }, rollback: { command: "echo rollback production" }, gate: { roles: [release] } }
`,
  });
}

/** CHG-0001 merged at MERGE from the PR head HEAD (stage 6, nothing deployed). */
function merged(tree = envTree()): Tree {
  const t = withChange(tree, {
    id: "CHG-0001",
    intent: true,
    spec: true,
    plan: { files: ["src/a.ts"], accepted: true },
    pr: { merged: true },
    runs: ["green"],
    events: [...acceptedThrough([1, 2, 3]), ev("gate.accepted", ENG, { gate: 5, artifactSha: SHA, source: "cli" }), ev("pr.merged", ENG, { mergeSha: MERGE })],
  });
  return withFiles(t, { "sdlc/changes/CHG-0001/pr.yaml": `schema: 1\nprovider: local\nbranch: CHG-0001/work\nbaseBranch: main\nheadSha: ${HEAD}\nopenedAt: 2026-09-03T12:00:00Z\nmergedAt: 2026-09-03T13:00:00Z\nmergeSha: ${MERGE}\nreviewers: []\nchecks: []\nplanMatches: true\n` });
}

function plan(r: ReturnType<typeof startDeployment>): WritePlan {
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
}

function apply(tree: Tree, r: ReturnType<typeof startDeployment>): Tree {
  const repo = loadRepo(tree);
  const p = plan(r);
  const report = validateWritePlan(repo, p);
  if (report.blocking) throw new Error(report.diagnostics.filter((d) => d.blocking).map((d) => `${d.rule}: ${d.message}`).join("; "));
  return applyWritePlan(tree, p);
}

const rule = (r: ReturnType<typeof startDeployment>) => (r.ok ? "ok" : (r.diagnostics[0]?.rule ?? "?"));
const AGENT_ACTOR = { type: "agent" as const, id: "claude-code@sdlc.local", session: "sess-dep" };

/** Staging deployed at `sha` by the agent and its rollback rehearsed, as one session record. */
function rehearsed(tree: Tree, sha = MERGE, rehearsalExit = 0): Tree {
  const { repo, view } = viewOf(tree, "CHG-0001");
  return apply(
    tree,
    recordSessionDeploys(
      repo,
      view,
      [
        { kind: "deploy", env: "staging", sha, startedAt: "2026-09-08T09:00:00Z", finishedAt: "2026-09-08T09:02:00Z", exitCode: 0, output: "deploying staging\nrelease 1 live\n", healthcheck: { command: "curl staging/health", exitCode: 0, output: "ok" } },
        { kind: "rehearsal", env: "staging", sha, rehearsedAt: "2026-09-08T09:05:00Z", finishedAt: "2026-09-08T09:06:00Z", exitCode: rehearsalExit, output: rehearsalExit === 0 ? "rolling staging back to the previous release\nrelease 0 live\n" : "rollback failed: no previous release\n" },
      ],
      AGENT_ACTOR,
      ctxFor("sdlc-bot@sdlc.local", "2026-09-08T09:07:00Z"),
    ),
  );
}

beforeEach(() => {
  resetSeq();
  n = 0;
});

describe("deploy.yaml schema (3.6)", () => {
  it("keeps a record written before 3.6 valid, accepts environment entries and rehearsals, and rejects unknown states", () => {
    const legacy: Deploy = { schema: 1, env: "production", version: "2026.08.23", at: "2026-08-23T10:00:00Z", status: "succeeded", authorizedBy: "eng@veri.example", authorizedAt: "2026-08-23T09:50:00Z" };
    expect(validate("deploy", legacy).ok).toBe(true);
    const record: Deploy = {
      schema: 1,
      env: "production",
      version: "b2b2b2b",
      at: "2026-09-08T10:01:00Z",
      status: "succeeded",
      environments: [
        { env: "staging", kind: "staging", status: "succeeded", sha: MERGE, version: "b2b2b2b", command: "echo deploy staging", startedAt: "2026-09-08T09:00:00Z", finishedAt: "2026-09-08T09:02:00Z", exitCode: 0, output: "ok", actor: { type: "agent", id: "claude-code@sdlc.local", session: "sess-dep" } },
        { env: "production", kind: "production", status: "succeeded", sha: MERGE, command: "echo deploy production", startedAt: "2026-09-08T10:00:00Z", finishedAt: "2026-09-08T10:01:00Z", exitCode: 0, output: "ok", actor: { type: "human", id: "release@example.com" }, authorizedBy: "release@example.com", authorizedAt: "2026-09-08T10:00:00Z" },
      ],
      rehearsals: [{ env: "staging", kind: "staging", sha: MERGE, status: "succeeded", command: "echo rollback staging", rehearsedAt: "2026-09-08T09:05:00Z", exitCode: 0, output: "ok", actor: { type: "agent", id: "claude-code@sdlc.local", session: "sess-dep" } }],
    };
    expect(validate("deploy", record).ok).toBe(true);
    expect(validate("deploy", { ...record, environments: [{ ...record.environments?.[0], status: "done" }] }).ok).toBe(false);
    expect(validate("deploy", { ...record, rehearsals: [{ ...record.rehearsals?.[0], status: "running" }] }).ok).toBe(false);
  });

  it("config: environments are unique slugs of three kinds; the production gate's roles are read, `eng` by default", () => {
    const repo = loadRepo(envTree());
    expect(repo.config.environments.map((e) => [e.name, e.kind, e.gateRoles])).toEqual([["staging", "staging", []], ["production", "production", ["release"]]]);
    const plain = loadRepo(withFiles(baseTree(), { "sdlc/config.yaml": "schema: 1\ndefaultRole: po\nidentities:\n  - { id: eng@example.com, roles: [eng] }\nenvironments:\n  - { name: production, kind: production, deploy: { command: x }, rollback: { command: y } }\n" }));
    expect(plain.config.environments[0]?.gateRoles).toEqual(["eng"]);
    const dup = loadRepo(withFiles(baseTree(), { "sdlc/config.yaml": "schema: 1\ndefaultRole: po\nidentities:\n  - { id: eng@example.com, roles: [eng] }\nenvironments:\n  - { name: staging, kind: staging, deploy: { command: x }, rollback: { command: y } }\n  - { name: staging, kind: preview, deploy: { command: x }, rollback: { command: y } }\n" }));
    expect(validateTree(dup).diagnostics.map((d) => d.rule)).toContain("config.environment-duplicate");
    const unowned = loadRepo(withFiles(baseTree(), { "sdlc/config.yaml": "schema: 1\ndefaultRole: po\nidentities:\n  - { id: eng@example.com, roles: [eng] }\nenvironments:\n  - { name: production, kind: production, deploy: { command: x }, rollback: { command: y }, gate: { roles: [release] } }\n" }));
    expect(validateTree(unowned).diagnostics.map((d) => d.rule)).toContain("config.production-gate-unowned");
  });
});

describe("derivation (3.6): environments, the rollback-rehearsed check and the production gate", () => {
  it("without environments nothing changes: no gate, stage 6 reads Deployed · monitoring", () => {
    const { view } = viewOf(merged(baseTree()), "CHG-0001");
    expect(view.stage).toBe(6);
    expect(view.status).toBe("Deployed · monitoring");
    expect(view.deploy).toEqual({ record: null, environments: [], rehearsals: [], productionGate: null });
  });

  it("the merge opens the production gate with sdlc/rollback-rehearsed pending; a succeeded rehearsal on staging at the merge sha (or the PR head) passes it; a failed one fails it; another sha does not count", () => {
    const { view } = viewOf(merged(), "CHG-0001");
    expect(view.stage).toBe(6);
    expect(view.status).toBe("Merged · production gate needs a rollback rehearsal");
    expect(view.deploy.environments.map((e) => [e.name, e.kind, e.status, e.agentDeployable])).toEqual([["staging", "staging", "not-deployed", true], ["production", "production", "not-deployed", false]]);
    expect(view.deploy.productionGate).toMatchObject({ env: "production", open: true, sha: MERGE, since: "2026-09-03T13:00:00Z", ownerRoles: ["release"], ownerLabel: "release", authorized: null, deployment: null });
    expect(view.deploy.productionGate?.checks).toEqual([expect.objectContaining({ name: ROLLBACK_CHECK, verdict: "pending", summary: expect.stringContaining("rehearse on staging first") })]);
    expect(view.deploy.productionGate?.blocked).toContain("pending");

    const green = viewOf(rehearsed(merged()), "CHG-0001").view;
    expect(green.status).toBe("Merged · production gate — waiting on the release");
    expect(green.deploy.environments[0]).toMatchObject({ name: "staging", status: "succeeded", latest: expect.objectContaining({ sha: MERGE, exitCode: 0, output: "deploying staging\nrelease 1 live\n", healthcheck: expect.objectContaining({ exitCode: 0 }) }) });
    expect(green.deploy.productionGate?.checks[0]).toMatchObject({ verdict: "pass", summary: expect.stringContaining("rehearsed on staging at b2b2b2b by claude-code@sdlc.local"), evidence: "rolling staging back to the previous release\nrelease 0 live\n" });
    expect(green.deploy.productionGate?.blocked).toBeNull();
    expect(green.activity.map((a) => a.event).slice(0, 3)).toEqual(["rollback.rehearsed", "deploy.finished", "deploy.started"]);
    expect(green.activity[0]?.text).toBe("rollback rehearsed on staging at b2b2b2b — succeeded");

    // the PR head, deployed and rehearsed before the merge commit wrapped it, is the same change
    expect(viewOf(rehearsed(merged(), HEAD), "CHG-0001").view.deploy.productionGate?.checks[0]?.verdict).toBe("pass");
    const red = viewOf(rehearsed(merged(), MERGE, 1), "CHG-0001").view;
    expect(red.deploy.productionGate?.checks[0]).toMatchObject({ verdict: "fail", summary: expect.stringContaining("failed (exit 1)"), evidence: "rollback failed: no previous release\n" });
    expect(red.status).toBe("Merged · production gate needs a rollback rehearsal");
    expect(viewOf(rehearsed(merged(), OTHER), "CHG-0001").view.deploy.productionGate?.checks[0]).toMatchObject({ verdict: "fail", summary: expect.stringContaining("succeeded at c3c3c3c, not b2b2b2b") });
    // the latest rehearsal at the commit decides: a rollback that broke after an earlier success is not rehearsed
    const broke = viewOf(rehearsed(rehearsed(merged()), MERGE, 1), "CHG-0001").view;
    expect(broke.deploy.productionGate?.checks[0]).toMatchObject({ verdict: "fail", summary: expect.stringContaining("failed (exit 1)") });
  });

  it("a production rehearsal never counts, and a record from before 3.6 saying production succeeded keeps the gate closed", () => {
    const repo = loadRepo(envTree());
    const check = rollbackRehearsedCheck(repo.config, { schema: 1, env: "production", version: "x", at: "2026-09-08T10:00:00Z", status: "succeeded", rehearsals: [{ env: "production", sha: MERGE, status: "succeeded", command: "x", rehearsedAt: "2026-09-08T10:00:00Z", exitCode: 0, output: "", actor: { type: "human", id: "release@example.com" } }] }, MERGE, HEAD);
    expect(check.verdict).toBe("pending");
    const legacy = withFiles(merged(), { "sdlc/changes/CHG-0001/deploy.yaml": "schema: 1\nenv: production\nversion: 2026.09.01\nat: 2026-09-03T14:00:00Z\nstatus: succeeded\nauthorizedBy: release@example.com\nauthorizedAt: 2026-09-03T13:50:00Z\n" });
    const { view } = viewOf(legacy, "CHG-0001");
    expect(view.deploy.productionGate).toMatchObject({ open: false, authorized: { by: "release@example.com", at: "2026-09-03T13:50:00Z" } });
    expect(view.deploy.environments.find((e) => e.name === "production")?.status).toBe("succeeded");
    expect(view.status).toBe("Deployed · monitoring");
    expect(validateTree(loadRepo(legacy)).blocking).toBe(false);
  });

  it("the open production gate queues for its role like the artifact gates, and counts in that role's badge", () => {
    const repo = loadRepo(rehearsed(merged()));
    const views = [...repo.changes.values()].map((f) => deriveChange(repo, f));
    expect(gateQueues(views, "release").yours.map((c) => c.id)).toEqual(["CHG-0001"]);
    expect(gateQueues(views, "eng").yours).toEqual([]);
    expect(gateQueues(views, "eng").other.map((c) => c.id)).toEqual(["CHG-0001"]);
    expect(badges(views, repo, "release" as never).gates).toBe(1);
    expect(check.productionGate(views[0] as never)).toMatchObject({ allowed: true, verdict: "pass" });
  });
});

describe("startDeployment / finishDeployment (3.6): the production gate", () => {
  it("refuses before the merge, for an agent, for a non-owner, without a rehearsal and at another sha; nothing runs before the refusal", () => {
    const open = withChange(envTree(), { id: "CHG-0002", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, pr: {}, runs: ["green"], events: acceptedThrough([1, 2, 3]) });
    const notMerged = viewOf(open, "CHG-0002");
    expect(notMerged.view.stage).toBe(5);
    expect(rule(startDeployment(notMerged.repo, notMerged.view, { env: "production", sha: SHA, actor: { type: "human", id: "release@example.com" } }, ctxFor("release@example.com")))).toBe("production.gate-closed");

    const { repo, view } = viewOf(merged(), "CHG-0001");
    const human = (id: string) => ({ type: "human" as const, id });
    expect(rule(startDeployment(repo, view, { env: "production", sha: MERGE, actor: AGENT_ACTOR }, ctxFor("release@example.com")))).toBe("production.actor-not-human");
    expect(rule(startDeployment(repo, view, { env: "production", sha: MERGE, actor: human("sdlc-bot") }, ctxFor("release@example.com")))).toBe("production.actor-not-human");
    expect(rule(startDeployment(repo, view, { env: "production", sha: MERGE, actor: human("eng@example.com") }, ctxFor("eng@example.com")))).toBe("production.not-owner");
    expect(rule(startDeployment(repo, view, { env: "production", sha: MERGE, actor: human("release@example.com") }, ctxFor("release@example.com")))).toBe("production.rollback-not-rehearsed");
    expect(rule(startDeployment(repo, view, { env: "nowhere", sha: MERGE, actor: human("release@example.com") }, ctxFor("release@example.com")))).toBe("deploy.env-unknown");

    const ready = viewOf(rehearsed(merged()), "CHG-0001");
    expect(rule(startDeployment(ready.repo, ready.view, { env: "production", sha: HEAD, actor: human("release@example.com") }, ctxFor("release@example.com")))).toBe("production.sha-mismatch");
    expect(rule(startDeployment(ready.repo, ready.view, { env: "production", sha: MERGE, actor: human("eng@example.com") }, ctxFor("eng@example.com")))).toBe("production.not-owner");
  });

  it("deploy.finished is recorded under the role deploy.authorized was — the gate role the person holds, not their first role (exit run 2026-09-09)", () => {
    let tree = rehearsed(merged());
    const before = viewOf(tree, "CHG-0001");
    const started = startDeployment(before.repo, before.view, { env: "production", sha: MERGE, actor: { type: "human", id: "ops@example.com" } }, ctxFor("ops@example.com"));
    expect(plan(started).events.map((e) => [e.event.event, e.event.actor.role])).toEqual([["deploy.authorized", "release"], ["deploy.started", "release"]]);
    tree = apply(tree, started);
    const running = viewOf(tree, "CHG-0001");
    const ok = finishDeployment(running.repo, running.view, { env: "production", sha: MERGE, exitCode: 0, output: "live\n" }, ctxFor("ops@example.com"));
    expect(plan(ok).events.map((e) => [e.event.event, e.event.actor.role])).toEqual([["deploy.finished", "release"]]);
    expect(plan(ok).actor).toEqual({ type: "human", id: "ops@example.com", role: "release" });
    const failed = finishDeployment(running.repo, running.view, { env: "production", sha: MERGE, exitCode: 1, output: "boom\n" }, ctxFor("ops@example.com"));
    expect(plan(failed).events.map((e) => [e.event.event, e.event.actor.role])).toEqual([["deploy.failed", "release"]]);
  });

  it("golden (Phase 3 exit): a change deploys through the production gate with a deploy.yaml record and a rehearsed rollback — the decision and deploy.started go first, the command's outcome second", () => {
    let tree = rehearsed(merged());
    const before = viewOf(tree, "CHG-0001");
    const started = startDeployment(before.repo, before.view, { env: "production", sha: MERGE, actor: { type: "human", id: "release@example.com" }, note: "release 1" }, ctxFor("release@example.com", "2026-09-08T10:00:00Z"));
    const p1 = plan(started);
    expect(p1.commitMessage).toBe("sdlc(CHG-0001): production gate accepted → deploy production ← b2b2b2b");
    expect(p1.events.map((e) => [e.event.event, e.event.actor.type, e.event.actor.role])).toEqual([["deploy.authorized", "human", "release"], ["deploy.started", "human", "release"]]);
    expect(p1.trailers).toEqual({ "SDLC-Event": p1.events[0]?.event.id, "SDLC-Actor": "human:release@example.com" });
    tree = apply(tree, started);
    const running = viewOf(tree, "CHG-0001");
    expect(running.view.status).toBe("Deploying to production · b2b2b2b");
    expect(running.view.deploy.productionGate).toMatchObject({ open: false, deployment: expect.objectContaining({ status: "running", authorizedBy: "release@example.com", authorizedAt: "2026-09-08T10:00:00Z" }) });
    // one deployment per environment at a time
    expect(rule(startDeployment(running.repo, running.view, { env: "production", sha: MERGE, actor: { type: "human", id: "release@example.com" } }, ctxFor("release@example.com")))).toBe("deploy.in-flight");

    const finished = finishDeployment(running.repo, running.view, { env: "production", sha: MERGE, exitCode: 0, output: "deploying production\nrelease 1 live\n" }, ctxFor("release@example.com", "2026-09-08T10:01:00Z"));
    const p2 = plan(finished);
    expect(p2.events.map((e) => [e.event.event, e.event.actor.id, e.event.actor.role])).toEqual([["deploy.finished", "release@example.com", "release"]]);
    tree = apply(tree, finished);
    const { repo, view, files } = viewOf(tree, "CHG-0001");
    expect(view.status).toBe("Deployed · monitoring");
    expect(view.deploy.productionGate).toMatchObject({ open: false, authorized: { by: "release@example.com", at: "2026-09-08T10:00:00Z" }, deployment: expect.objectContaining({ status: "succeeded", output: "deploying production\nrelease 1 live\n" }) });
    expect(view.deploy.environments.map((e) => [e.name, e.status])).toEqual([["staging", "succeeded"], ["production", "succeeded"]]);
    expect(validateTree(repo).blocking).toBe(false);
    expect(validate("deploy", files.deploy).ok).toBe(true);

    const doc = { deploy: files.deploy, events: files.events.filter((e) => e.event.startsWith("deploy.") || e.event.startsWith("rollback.")).map((e) => ({ event: e.event, actor: e.actor, data: e.data })) };
    mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    expect(doc).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));

    // a failed production deploy reopens the gate for a redeploy; the failure and its output stay on record
    const again = viewOf(rehearsed(merged()), "CHG-0001");
    let t2 = apply(rehearsed(merged()), startDeployment(again.repo, again.view, { env: "production", sha: MERGE, actor: { type: "human", id: "release@example.com" } }, ctxFor("release@example.com")));
    const r2 = viewOf(t2, "CHG-0001");
    t2 = apply(t2, finishDeployment(r2.repo, r2.view, { env: "production", sha: MERGE, exitCode: 3, output: "rollout stuck\n" }, ctxFor("release@example.com")));
    const failed = viewOf(t2, "CHG-0001");
    expect(failed.view.status).toBe("production deploy failed (exit 3) — production gate open again for the release");
    expect(failed.view.deploy.productionGate).toMatchObject({ open: true, deployment: expect.objectContaining({ status: "failed", exitCode: 3, output: "rollout stuck\n" }) });
    expect(failed.view.activity[0]).toMatchObject({ event: "deploy.failed", text: "deploy to production failed: echo deploy production exited 3" });
    expect(validateTree(failed.repo).blocking).toBe(false);
  });

  it("non-production: a person deploys staging without a gate; finish records the healthcheck; a second deploy waits for the first", () => {
    const { repo, view } = viewOf(merged(), "CHG-0001");
    const started = startDeployment(repo, view, { env: "staging", sha: MERGE, actor: { type: "human", id: "eng@example.com" } }, ctxFor("eng@example.com"));
    const p = plan(started);
    expect(p.events.map((e) => [e.event.event, e.event.actor.type, e.event.actor.role])).toEqual([["deploy.started", "human", "eng"]]);
    expect(p.commitMessage).toBe("sdlc(CHG-0001): deploy staging ← b2b2b2b");
    const t1 = apply(merged(), started);
    const r1 = viewOf(t1, "CHG-0001");
    expect(rule(startDeployment(r1.repo, r1.view, { env: "staging", sha: MERGE, actor: { type: "human", id: "eng@example.com" } }, ctxFor("eng@example.com")))).toBe("deploy.in-flight");
    expect(rule(finishDeployment(r1.repo, r1.view, { env: "production", sha: MERGE, exitCode: 0, output: "" }, ctxFor("eng@example.com")))).toBe("deploy.not-running");
    const t2 = apply(t1, finishDeployment(r1.repo, r1.view, { env: "staging", sha: MERGE, exitCode: 0, output: "ok\n", healthcheck: { command: "curl staging/health", exitCode: 7, output: "connection refused" } }, ctxFor("eng@example.com")));
    const { view: after } = viewOf(t2, "CHG-0001");
    expect(after.deploy.environments[0]?.latest).toMatchObject({ status: "failed", exitCode: 0, healthcheck: { exitCode: 7, output: "connection refused" } });
    expect(after.activity[0]?.text).toBe("deploy to staging failed: healthcheck exited 7");
  });
});

describe("recordSessionDeploys / recordDeployment / recordRehearsal (3.6)", () => {
  it("records an agent's deploy and rehearsal in one sdlc-bot plan with the agent as actor; refuses production, a rehearsal with nothing deployed, and a rehearsal at another sha", () => {
    const { repo, view } = viewOf(merged(), "CHG-0001");
    const both = recordSessionDeploys(repo, view, [{ kind: "deploy", env: "staging", sha: HEAD, startedAt: "2026-09-08T09:00:00Z", finishedAt: "2026-09-08T09:01:00Z", exitCode: 0, output: "up" }, { kind: "rehearsal", env: "staging", sha: HEAD, rehearsedAt: "2026-09-08T09:02:00Z", exitCode: 0, output: "down" }], AGENT_ACTOR, ctxFor("sdlc-bot@sdlc.local"));
    const p = plan(both);
    expect(p.commitMessage).toBe("sdlc(CHG-0001): deploy staging ← a1a1a1a succeeded · rollback rehearsed on staging at a1a1a1a succeeded");
    expect(p.trailers).toEqual({ "SDLC-Event": p.events[0]?.event.id, "SDLC-Actor": "agent:claude-code@sdlc.local", "SDLC-Session": "sess-dep" });
    expect(p.actor).toEqual({ type: "agent", id: "claude-code@sdlc.local", session: "sess-dep" });
    expect(p.events.map((e) => [e.event.event, e.event.actor.type])).toEqual([["deploy.started", "agent"], ["deploy.finished", "agent"], ["rollback.rehearsed", "agent"]]);
    expect(validateWritePlan(repo, p).blocking).toBe(false);

    expect(rule(recordDeployment(repo, view, { env: "production", sha: MERGE, startedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "", actor: AGENT_ACTOR }, ctxFor("sdlc-bot@sdlc.local")))).toBe("production.recorded-without-gate");
    expect(rule(recordRehearsal(repo, view, { env: "staging", sha: MERGE, rehearsedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "", actor: AGENT_ACTOR }, ctxFor("sdlc-bot@sdlc.local")))).toBe("rehearsal.nothing-deployed");
    expect(rule(recordRehearsal(repo, view, { env: "production", sha: MERGE, rehearsedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "", actor: { type: "human", id: "release@example.com" } }, ctxFor("release@example.com")))).toBe("rehearsal.production");
    const staged = viewOf(apply(merged(), recordDeployment(repo, view, { env: "staging", sha: HEAD, startedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "up", actor: { type: "human", id: "eng@example.com" } }, ctxFor("eng@example.com"))), "CHG-0001");
    expect(rule(recordRehearsal(staged.repo, staged.view, { env: "staging", sha: MERGE, rehearsedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "", actor: { type: "human", id: "eng@example.com" } }, ctxFor("eng@example.com")))).toBe("rehearsal.sha-mismatch");
    const ok = recordRehearsal(staged.repo, staged.view, { env: "staging", sha: HEAD, rehearsedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "down", actor: { type: "human", id: "eng@example.com" } }, ctxFor("eng@example.com"));
    expect(plan(ok).events.map((e) => [e.event.event, e.event.actor.role])).toEqual([["rollback.rehearsed", "eng"]]);
  });

  it("output is kept verbatim up to the limit and clipped with a note beyond it, never summarised", () => {
    const { repo, view } = viewOf(merged(), "CHG-0001");
    const big = "x".repeat(250_000);
    const p = plan(recordDeployment(repo, view, { env: "staging", sha: HEAD, startedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: big, actor: AGENT_ACTOR }, ctxFor("sdlc-bot@sdlc.local")));
    const record = loadRepo(applyWritePlan(merged(), p)).changes.get("CHG-0001")?.deploy;
    const out = record?.environments?.[0]?.output ?? "";
    expect(out.startsWith("x".repeat(200_000))).toBe(true);
    expect(out).toContain("… 50000 more characters not recorded (output clipped at 200000 characters)");
  });
});

describe("validation (3.6): the ledger and deploy.yaml cannot be hand-written around the gate", () => {
  const production = (extra: Partial<NonNullable<Deploy["environments"]>[number]> = {}) => ({ env: "production", kind: "production" as const, status: "succeeded" as const, sha: MERGE, command: "echo deploy production", startedAt: "2026-09-08T10:00:00Z", finishedAt: "2026-09-08T10:01:00Z", exitCode: 0, output: "", actor: { type: "human" as const, id: "release@example.com" }, ...extra });
  const record = (environments: NonNullable<Deploy["environments"]>, rehearsals: Deploy["rehearsals"] = []): string => JSON.stringify({ schema: 1, env: "production", version: "x", at: "2026-09-08T10:01:00Z", status: "succeeded", environments, rehearsals });

  it("a production entry without deploy.authorized, without a rehearsal, or by an agent is blocking; deploy.authorized by a non-owner is blocking", () => {
    const rules = (tree: Tree) => validateTree(loadRepo(tree)).diagnostics.filter((d) => d.blocking).map((d) => d.rule);
    expect(rules(withFiles(merged(), { "sdlc/changes/CHG-0001/deploy.yaml": record([production()]) }))).toEqual(expect.arrayContaining(["deploy.production-unauthorized", "deploy.production-unrehearsed"]));
    const rehearsal = { env: "staging", kind: "staging" as const, sha: MERGE, status: "succeeded" as const, command: "echo rollback staging", rehearsedAt: "2026-09-08T09:00:00Z", exitCode: 0, output: "", actor: { type: "agent" as const, id: "claude-code@sdlc.local", session: "s" } };
    const forgedActor = withChange(envTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, pr: { merged: true }, runs: ["green"], events: [...acceptedThrough([1, 2, 3]), ev("gate.accepted", ENG, { gate: 5, artifactSha: SHA, source: "cli" }), ev("pr.merged", ENG, { mergeSha: MERGE }), ev("deploy.authorized", ENG, { env: "production", sha: MERGE })] });
    expect(rules(withFiles(forgedActor, { "sdlc/changes/CHG-0001/deploy.yaml": record([production({ authorizedBy: "eng@example.com" })], [rehearsal]) }))).toEqual(expect.arrayContaining(["deploy.actor-not-owner"]));
    expect(rules(withFiles(merged(), { "sdlc/changes/CHG-0001/deploy.yaml": record([production({ actor: { type: "agent", id: "claude-code@sdlc.local", session: "s" } })], [rehearsal]) }))).toEqual(expect.arrayContaining(["deploy.production-not-human", "deploy.production-unauthorized"]));
    expect(rules(withFiles(merged(), { "sdlc/changes/CHG-0001/deploy.yaml": record([], [{ ...rehearsal, env: "production", kind: "production" }]) }))).toEqual(expect.arrayContaining(["rehearsal.production"]));
    // an agent-authored deploy.authorized never parses (human-only by schema)
    const agentAuthorized = withChange(envTree(), { id: "CHG-0001", intent: true, spec: true, plan: { files: ["src/a.ts"], accepted: true }, pr: { merged: true }, runs: ["green"], events: [...acceptedThrough([1, 2, 3]), ev("gate.accepted", ENG, { gate: 5, artifactSha: SHA, source: "cli" }), ev("pr.merged", ENG, { mergeSha: MERGE }), ev("deploy.authorized", AGENT, { env: "production", sha: MERGE })] });
    expect(loadRepo(agentAuthorized).changes.get("CHG-0001")?.diagnostics.some((d) => d.path.endsWith("log.jsonl") && d.severity === "error")).toBe(true);
  });
});

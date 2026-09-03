import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { blobSha, commitWritePlan, currentBranch, defaultBranch, isRepo, newUlid, readTree, repoRoot } from "@sdlc/adapter-git";
import { STAGES, awaitingArtifact, check, deriveAll, deriveChange, eventsNamed, lastEvent, loadRepo, logPath, type ChangeFiles, type ChangeView, type Repo, type WritePlan } from "@sdlc/core";
import { appendHookEvent } from "@sdlc/hooks";
import { changeId as changeIdSchema, parseArtifact, parsePlan, roundResult, severity, stringifyFrontMatter, stringifyJson, type Diagnostic, type Event, type EventName, type EventOf } from "@sdlc/schemas";
import { z } from "zod";
import { buildContext } from "./context-bundle.js";
import { agentIdentity, sessionIdFrom } from "./identity.js";
import { appendFinding, appendRound, clearWaiting, dirtyHash, loopState, readFindings, readRounds, setWaiting, type StoredFinding, type StoredRound } from "./sessions.js";

export interface ServerOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface Loaded {
  root: string;
  branch: string;
  base: string;
  repo: Repo;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function refuse(message: string, diagnostics: Diagnostic[] = []): ToolResult {
  const value = { error: message, diagnostics };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: true };
}

class Refusal extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}

/** The ten agent-facing tools (blueprint §9.3). No accept, merge, approve, freeze-lift or repro-confirm exists here. */
export function createSdlcServer(opts: ServerOptions): McpServer {
  const env = opts.env ?? process.env;
  const now = () => (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const who = agentIdentity(env);
  const server = new McpServer({ name: "sdlc-mcp", version: "0.1.0" });

  async function load(): Promise<Loaded> {
    if (!(await isRepo(opts.cwd))) throw new Refusal(`${opts.cwd} is not a git repository`);
    const root = await repoRoot(opts.cwd);
    const branch = await currentBranch(root);
    const repo = loadRepo(await readTree(root, "HEAD"));
    const base = repo.rawConfig?.defaultBranch ?? (await defaultBranch(root));
    return { root, branch, base, repo };
  }

  function viewOf(repo: Repo, id: string): { files: ChangeFiles; view: ChangeView } {
    const files = repo.changes.get(id);
    if (!files) throw new Refusal(`${id} not found under sdlc/changes/`);
    return { files, view: deriveChange(repo, files) };
  }

  function requireChangeBranch(l: Loaded, id: string): void {
    if (l.branch === l.base) {
      throw new Refusal(`writes are refused on the default branch ${l.base}; work on a change branch such as sdlc/${id}/<artifact> or ${id}/<task> (the launcher creates it)`);
    }
  }

  /** Highest seq in the committed ledger or the working-tree file (hooks append rounds uncommitted). */
  function maxSeq(root: string, files: ChangeFiles): number {
    let max = Math.max(0, ...files.events.map((e) => e.seq));
    const abs = join(root, logPath(files.id));
    if (existsSync(abs)) {
      for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
        const m = /"seq":\s*(\d+)/.exec(line);
        if (m?.[1]) max = Math.max(max, Number(m[1]));
      }
    }
    return max;
  }

  function agentEvent<N extends EventName>(files: ChangeFiles, session: string, name: N, data: EventOf<N>["data"], seqOffset = 0, root?: string): Event {
    const seq = (root ? maxSeq(root, files) : Math.max(0, ...files.events.map((e) => e.seq))) + 1 + seqOffset;
    return { schema: 1, id: newUlid(), ts: now(), seq, cycle: files.change?.cycle ?? 1, actor: { type: "agent", id: who.id, session }, event: name, data } as unknown as Event;
  }

  async function commit(l: Loaded, id: string, files: WritePlan["files"], events: Event[], message: string): Promise<string> {
    const plan: WritePlan = { changeId: id, files, events: events.map((event) => ({ changeId: id, event })), commitMessage: message, trailers: { "SDLC-Actor": `agent:${who.id}`, ...(events[0] ? { "SDLC-Event": events[0].id } : {}) }, actor: { type: "agent", id: who.id, session: "mcp" } };
    return commitWritePlan(l.root, plan, { identity: who });
  }

  const guard = (fn: () => Promise<ToolResult>): Promise<ToolResult> =>
    fn().catch((e: unknown) => (e instanceof Refusal ? refuse(e.message, e.diagnostics) : refuse(`internal error: ${(e as Error).message}`)));

  server.registerTool(
    "list_work",
    { description: "Changes awaiting an agent-produced artifact (agent=true), optionally filtered by stage or change id.", inputSchema: { stage: z.number().int().min(1).max(6).optional(), changeId: changeIdSchema.optional() } },
    (args) =>
      guard(async () => {
        const l = await load();
        const all = deriveAll(l.repo).changes;
        const work = awaitingArtifact(all, args.stage as 1 | 2 | 3 | 4 | 5 | 6 | undefined).filter((c) => !args.changeId || c.id === args.changeId);
        return ok({
          branch: l.branch,
          work: work.map((c) => ({ id: c.id, title: c.title, cycle: c.cycle, stage: c.stage, stageName: c.stageName, status: c.status, awaited: STAGES[c.stage - 1]?.file ?? "", planFiles: c.planFiles, acceptanceLine: c.acceptanceLine, kind: c.kind, risk: c.risk })),
        });
      }),
  );

  server.registerTool(
    "get_change",
    { description: "Derived view of one change: stage, gate, docs, plan state, eligibility, activity, validation.", inputSchema: { id: changeIdSchema } },
    (args) =>
      guard(async () => {
        const l = await load();
        const { view } = viewOf(l.repo, args.id);
        return ok(view as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "get_context",
    { description: "Context bundle for the change's current stage: files with shas (already on disk), prompt template, allowed tools, and the manifest hash to put in context_manifest.", inputSchema: { changeId: changeIdSchema } },
    (args) =>
      guard(async () => {
        const l = await load();
        const { view } = viewOf(l.repo, args.changeId);
        return ok(buildContext(l.repo, view) as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "propose_artifact",
    {
      description: "Write intent.md (0), spec.md (1) or incident.md (5) for the change on the current change branch. Front-matter is completed and chained automatically; the artifact is validated against its template and committed only when complete. Never accepts a gate.",
      inputSchema: { changeId: changeIdSchema, index: z.union([z.literal(0), z.literal(1), z.literal(5)]), body: z.string().min(1), frontMatter: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional() },
    },
    (args) =>
      guard(async () => {
        const l = await load();
        requireChangeBranch(l, args.changeId);
        const { files, view } = viewOf(l.repo, args.changeId);
        const kind = args.index === 0 ? "intent" : args.index === 1 ? "spec" : "incident";
        const doc = view.docs[args.index];
        if (doc.state === "committed" || doc.state === "stale") throw new Refusal(`${doc.name} is already accepted for cycle ${view.cycle}`);
        const expectedIndex = STAGES[view.stage - 1]?.artifactIndex;
        if (expectedIndex !== args.index) throw new Refusal(`${view.id} is at stage ${view.stage} (${view.stageName}); the awaited artifact is index ${expectedIndex}, not ${args.index}`);
        const fm = args.frontMatter ?? {};
        const bundle = buildContext(l.repo, view);
        const cycle = files.change?.cycle ?? 1;
        const base: Record<string, unknown> = { id: view.id, artifact: kind, cycle };
        if (kind === "intent") Object.assign(base, { author: who.id, created: now(), status: "final" });
        if (kind === "spec") {
          const acc1 = lastEvent(files.events.filter((e) => e.cycle === cycle), "gate.accepted", (e) => e.data.gate === 1);
          Object.assign(base, { intent_sha: acc1?.data.artifactSha ?? doc.sha ?? view.docs[0].sha, prompt_ref: fm["prompt_ref"] ?? bundle.promptRef, skills: fm["skills"] ?? bundle.skills, concerns: fm["concerns"] ?? [], created: now() });
        }
        if (kind === "incident") Object.assign(base, { src: fm["src"] ?? "agent", tier: fm["tier"] ?? "incident", created: now() });
        Object.assign(base, { context_manifest: bundle.manifest, schema: 1 });
        const text = stringifyFrontMatter(base, args.body);
        const path = `${files.dir}/${kind}.md`;
        const parsed = parseArtifact(kind, text, path);
        if (!parsed.ok || !parsed.value) {
          const sections = parsed.diagnostics.filter((d) => d.rule.startsWith("artifact.section")).map((d) => d.message);
          throw new Refusal(sections.length > 0 ? `artifact incomplete — ${sections.join("; ")}` : "artifact rejected by its schema", parsed.diagnostics);
        }
        if (!parsed.value.complete) throw new Refusal(`artifact incomplete — fill: ${[...parsed.value.missingSections, ...parsed.value.emptySections].join(", ")}`, parsed.diagnostics);
        const session = sessionIdFrom(env, args.sessionId);
        const sha = blobSha(text);
        const events = [agentEvent(files, session, "artifact.committed", { artifact: args.index, path, sha })];
        const commitSha = await commit(l, view.id, [{ path, content: text }], events, `sdlc(${view.id}): propose ${kind}.md`);
        return ok({ path, sha, commit: commitSha, branch: l.branch, manifest: bundle.manifest, diagnostics: parsed.diagnostics, next: `the ${STAGES[view.stage - 1]?.gate ? "gate owner accepts" : "stage advances"} on the default branch` });
      }),
  );

  server.registerTool(
    "submit_plan_revision",
    {
      description: "Write plan.md rev n+1 on the current change branch. final=true marks it final and opens gate 3 for the engineer. Files that change must be listed in the body.",
      inputSchema: { changeId: changeIdSchema, body: z.string().min(1), final: z.boolean(), acceptanceLine: z.string().optional(), sessionId: z.string().optional() },
    },
    (args) =>
      guard(async () => {
        const l = await load();
        requireChangeBranch(l, args.changeId);
        const { files, view } = viewOf(l.repo, args.changeId);
        if (view.stage !== 3) throw new Refusal(`${view.id} is at stage ${view.stage}; plan revisions belong to stage 3`);
        if (view.planState === "committed") throw new Refusal("plan.md is already accepted");
        const cycle = files.change?.cycle ?? 1;
        const acc2 = lastEvent(files.events.filter((e) => e.cycle === cycle), "gate.accepted", (e) => e.data.gate === 2);
        const rev = view.planRev + 1;
        const bundle = buildContext(l.repo, view);
        const fm = { id: view.id, artifact: "plan", cycle, spec_sha: acc2?.data.artifactSha ?? view.docs[1].sha, rev, accepted_by: null, accepted_at: null, acceptance_line: args.acceptanceLine ?? files.plan?.acceptanceLine ?? "", context_manifest: bundle.manifest, schema: 1 };
        const text = stringifyFrontMatter(fm, args.body);
        const path = `${files.dir}/plan.md`;
        const parsed = parsePlan(text, path);
        if (!parsed.ok || !parsed.value) throw new Refusal("plan rejected by its schema", parsed.diagnostics);
        if (args.final && (!parsed.value.complete || parsed.value.files.length === 0)) {
          throw new Refusal(`a final plan must be complete and list files: ${[...parsed.value.missingSections, ...parsed.value.emptySections, ...(parsed.value.files.length === 0 ? ["Files that change"] : [])].join(", ")}`, parsed.diagnostics);
        }
        const session = sessionIdFrom(env, args.sessionId);
        const sha = blobSha(text);
        const events = [agentEvent(files, session, "artifact.committed", { artifact: 2, path, sha }), agentEvent(files, session, "plan.drafted", { rev }, 1)];
        if (args.final) events.push(agentEvent(files, session, "plan.final", { rev }, 2));
        const commitSha = await commit(l, view.id, [{ path, content: text }], events, `sdlc(${view.id}): plan.md rev ${rev}${args.final ? " (final)" : ""}`);
        return ok({ rev, final: args.final, files: parsed.value.files.map((f) => f.path), commit: commitSha, gateOpens: args.final, diagnostics: parsed.diagnostics });
      }),
  );

  server.registerTool(
    "report_round",
    {
      description: "Record one feedback-loop round (named command results with verbatim excerpts). Returns the loop state: iterating, green, stalled or flaky.",
      inputSchema: { sessionId: z.string().optional(), results: z.array(roundResult).min(1), screenshotRef: z.string().optional(), diffPct: z.number().min(0).max(100).optional(), changeId: changeIdSchema.optional() },
    },
    (args) =>
      guard(async () => {
        const l = await load();
        const session = sessionIdFrom(env, args.sessionId);
        const id = args.changeId ?? /^(CHG-\d{4})/.exec(l.branch)?.[1] ?? null;
        const previous = readRounds(l.root, session) as StoredRound[];
        const round: StoredRound = { n: previous.length + 1, ts: now(), results: args.results, ...(args.screenshotRef ? { screenshotRef: args.screenshotRef } : {}), ...(args.diffPct !== undefined ? { diffPct: args.diffPct } : {}), dirtyHash: await dirtyHash(l.root) };
        appendRound(l.root, session, round);
        if (id && l.repo.changes.has(id)) {
          const cycle = l.repo.changes.get(id)?.change?.cycle ?? 1;
          appendHookEvent(l.root, id, cycle, session, "round", { n: round.n, results: round.results.map((r) => ({ ...r, outputExcerpt: r.outputExcerpt.slice(-600) })), ...(round.screenshotRef ? { screenshotRef: round.screenshotRef } : {}), ...(round.diffPct !== undefined ? { diffPct: round.diffPct } : {}) }, new Date(now()));
        }
        const max = l.repo.config.thresholds.maxLoopRounds;
        const state = loopState([...previous, round], max);
        return ok({ n: round.n, loopState: state, maxLoopRounds: max, changeId: id, ...(state === "stalled" ? { note: "waiting on you: loop not converging — the engineer can add guidance, raise the cap once, or take over" } : {}) });
      }),
  );

  server.registerTool(
    "report_done",
    {
      description: "Report the session done. Accepted only when the latest recorded round is all green with output (verify-before-done); then final-round.json is committed as evidence. Otherwise blocked with the reason.",
      inputSchema: { sessionId: z.string().optional(), evidenceRef: z.string().optional(), changeId: changeIdSchema.optional() },
    },
    (args) =>
      guard(async () => {
        const l = await load();
        const session = sessionIdFrom(env, args.sessionId);
        const rounds = readRounds(l.root, session) as StoredRound[];
        const verdict = check.verifyBeforeDone(rounds);
        if (!verdict.allowed) return ok({ accepted: false, blocked: true, reason: verdict.reason, rounds: rounds.length });
        const id = args.changeId ?? /^(CHG-\d{4})/.exec(l.branch)?.[1] ?? null;
        if (!id) return ok({ accepted: true, committed: false, reason: "no change context on this branch; nothing recorded", rounds: rounds.length });
        requireChangeBranch(l, id);
        const { files } = viewOf(l.repo, id);
        const last = rounds.at(-1);
        if (!last) throw new Refusal("no round");
        const final = { schema: 1, n: last.n, ts: last.ts, results: last.results, ...(last.screenshotRef ? { screenshotRef: last.screenshotRef } : {}), ...(last.diffPct !== undefined ? { diffPct: last.diffPct } : {}) };
        const events = [agentEvent(files, session, "session.stopped", { session, reason: "done" }, 0, l.root)];
        const commitSha = await commit(l, id, [{ path: `${files.dir}/evals/final-round.json`, content: stringifyJson(final) }], events, `sdlc(${id}): session ${session} done · final round ${last.n} green`);
        clearWaiting(l.root, session);
        return ok({ accepted: true, committed: true, commit: commitSha, finalRound: last.n, evidence: `${files.dir}/evals/final-round.json`, ...(args.evidenceRef ? { evidenceRef: args.evidenceRef } : {}) });
      }),
  );

  server.registerTool(
    "request_input",
    { description: "Ask the engineer a question; marks the session waiting-on-you and logs the question to the change.", inputSchema: { sessionId: z.string().optional(), question: z.string().min(1), changeId: changeIdSchema.optional() } },
    (args) =>
      guard(async () => {
        const l = await load();
        const session = sessionIdFrom(env, args.sessionId);
        setWaiting(l.root, session, args.question, now());
        const id = args.changeId ?? /^(CHG-\d{4})/.exec(l.branch)?.[1] ?? null;
        if (id && l.repo.changes.has(id)) {
          const { files } = viewOf(l.repo, id);
          const commitSha = await commit(l, id, [], [agentEvent(files, session, "question", { text: args.question }, 0, l.root)], `sdlc(${id}): question from session ${session}`);
          return ok({ ack: true, waitingOnYou: args.question, commit: commitSha });
        }
        return ok({ ack: true, waitingOnYou: args.question, commit: null });
      }),
  );

  server.registerTool(
    "report_finding",
    {
      description: "Report one review finding against the change's pull request (severity high|medium|low, title, optional path and detail). Findings are kept with the session and mirrored into the change by the system; they inform the code owner and never approve, request changes or block on their own.",
      inputSchema: { changeId: changeIdSchema, severity, title: z.string().min(1), path: z.string().optional(), detail: z.string().optional(), sessionId: z.string().optional() },
    },
    (args) =>
      guard(async () => {
        const l = await load();
        const { view } = viewOf(l.repo, args.changeId);
        if (!view.pr) throw new Refusal(`${view.id} has no pull request yet (stage ${view.stage}: ${view.stageName}); findings belong to the PR review`);
        if (view.pr.mergedAt !== undefined) throw new Refusal(`${view.id}'s PR is already merged`);
        const session = sessionIdFrom(env, args.sessionId);
        const previous = readFindings(l.root, session);
        const finding: StoredFinding = { n: previous.length + 1, ts: now(), severity: args.severity, title: args.title, ...(args.path ? { path: args.path } : {}), ...(args.detail ? { detail: args.detail } : {}) };
        appendFinding(l.root, session, finding);
        const all = [...previous, finding];
        return ok({ n: finding.n, changeId: view.id, headSha: view.pr.headSha, tally: { high: all.filter((f) => f.severity === "high").length, medium: all.filter((f) => f.severity === "medium").length, low: all.filter((f) => f.severity === "low").length }, note: "mirrored into pr.yaml and the ledger when the session ends" });
      }),
  );

  server.registerTool(
    "log_note",
    { description: "Append a note event to the change ledger (committed on the current branch).", inputSchema: { changeId: changeIdSchema, text: z.string().min(1), sessionId: z.string().optional() } },
    (args) =>
      guard(async () => {
        const l = await load();
        const { files } = viewOf(l.repo, args.changeId);
        const session = sessionIdFrom(env, args.sessionId);
        const event = agentEvent(files, session, "note", { text: args.text }, 0, l.root);
        const commitSha = await commit(l, args.changeId, [], [event], `sdlc(${args.changeId}): note`);
        return ok({ eventId: event.id, commit: commitSha, path: logPath(args.changeId) });
      }),
  );

  void eventsNamed;
  return server;
}

export const AGENT_TOOL_NAMES = ["list_work", "get_change", "get_context", "propose_artifact", "submit_plan_revision", "report_round", "report_done", "report_finding", "request_input", "log_note"] as const;

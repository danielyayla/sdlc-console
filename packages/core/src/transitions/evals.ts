import { stringifyFrontMatter, stringifyJson, type EvalCase, type Triage } from "@sdlc/schemas";
import type { ChangeView } from "../derive.js";
import { evalSignals, nextCaseId, type EvalSignal } from "../evals.js";
import { nextId } from "../ids.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, SYSTEM_ACTOR, trailersFor, type TransitionContext } from "./context.js";

function triageBody(s: EvalSignal): string {
  const outcome = s.kind === "retire" ? `Decide whether ${s.caseId} is retired (history kept) or hardened with a check that can fail; the suite's pass rate should measure something again.` : `Repair or replace ${s.caseId}'s checks so a pass means the behaviour holds; until then its failures are noise in the pass rate.`;
  return `# Intent: ${s.title}

## Problem
${s.evidence}

## Proposed outcome
${outcome}

## Affected users and systems
Eval suite (evals/cases/${s.caseId}.json); every config PR gated by the suite.

## Constraints
Retiring keeps the case file and its run history; a case is never deleted.

## Open questions
${s.kind === "retire" ? "Did the behaviour the case guards become impossible to break, or did the check stop looking?" : "Did the check's environment change (fixtures, tooling) rather than the configuration?"}
`;
}

/** A signal is already on file when a triage item with its `src` is open, or was raised at or after the streak's first run. */
function alreadyRaised(repo: Repo, s: EvalSignal): boolean {
  const first = repo.evalRuns.find((r) => r.id === s.runs[0])?.startedAt ?? "";
  return repo.triage.some((t) => t.data.src === s.src && (t.data.status === "open" || t.data.createdAt >= first));
}

/**
 * Retire / broken-check signals become triage items (FR-61; spec "retire-or-
 * harden", "broken check"). System actor: whoever ran the suite commits them.
 * Deduped by `src`, so a streak raises one item however many runs extend it.
 */
export function raiseEvalSignals(repo: Repo, ctx: Pick<TransitionContext, "now">): TransitionResult & { signals?: EvalSignal[] } {
  const pending = evalSignals(repo).filter((s) => !alreadyRaised(repo, s));
  if (pending.length === 0) return refuse("evals.no-signals", "no new eval signals");
  const ids = repo.triage.map((t) => t.data.id);
  const files: WritePlan["files"] = [];
  const raised: string[] = [];
  for (const s of pending) {
    const id = nextId("TRI", [...ids, ...raised]);
    raised.push(id);
    const data: Triage = { schema: 1, id, tier: s.kind === "retire" ? "eval-retire" : "flaky", src: s.src, title: s.title, evidence: s.evidence, createdAt: ctx.now, status: "open" };
    files.push({ path: `sdlc/loop/triage/${id}.md`, content: stringifyFrontMatter(data as unknown as Record<string, unknown>, triageBody(s)) });
  }
  return {
    ok: true,
    signals: pending,
    plan: {
      changeId: null,
      files,
      events: [],
      commitMessage: `sdlc(evals): ${raised.length} triage item${raised.length === 1 ? "" : "s"} from the suite (${pending.map((s) => `${s.kind} ${s.caseId}`).join(", ")})`,
      trailers: { "SDLC-Actor": `system:${SYSTEM_ACTOR.id}` },
      actor: SYSTEM_ACTOR,
    },
  };
}

/** The case a change was harvested into, if any. */
export function harvestedCase(repo: Pick<Repo, "evalCases">, changeId: string): EvalCase | null {
  return repo.evalCases.find((c) => c.source.type === "change" && c.source.ref === changeId) ?? null;
}

/**
 * Harvest (FR-53, spec 5B.5(a)): post-merge "Add as eval" drafts a case for
 * the platform owner — prompt from the intent title and the plan's acceptance
 * line, checks from the verification commands, paths from the plan. Draft
 * cases are excluded from the pass rate until the owner activates them.
 */
export function harvestCase(repo: Repo, view: ChangeView, ctx: TransitionContext): TransitionResult & { caseId?: string } {
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (view.stage !== 6) return refuse("harvest.not-merged", `${view.id} is not merged (stage ${view.stage}); harvest after the code PR merges`);
  const existing = harvestedCase(repo, view.id);
  if (existing) return refuse("harvest.exists", `${view.id} was already harvested as ${existing.id} (${existing.status})`);
  const id = nextCaseId(repo.evalCases);
  const owner = repo.config.identities.find((i) => i.roles.includes("platform"))?.id ?? ctx.actor.id;
  const checks = (repo.verification?.commands ?? []).filter((c) => c.name !== "visual").map((c) => ({ name: c.name, cmd: c.cmd, ...(c.healthyOutput ? { healthyOutput: c.healthyOutput } : {}) }));
  const prompt = `${view.title}. ${view.acceptanceLine ? `Acceptance: ${view.acceptanceLine.trim().replace(/\.$/, "")}. ` : ""}Behaviour outside this change is unchanged.`;
  const evalCase: EvalCase = { schema: 1, id, prompt, checks, source: { type: "change", ref: view.id }, owner, added: ctx.now, status: "draft", paths: view.planFiles };
  const ev = new EventBuilder(ctx, files, view.id);
  const events = [ev.human("note", null, files.change.cycle, { text: `harvested as ${id} (draft) — owner ${owner}${checks.length === 0 ? "; no verification commands, checks missing" : ""}` })];
  return {
    ok: true,
    caseId: id,
    plan: {
      changeId: view.id,
      files: [{ path: `evals/cases/${id}.json`, content: stringifyJson(evalCase) }],
      events: events.map((e) => ev.write(e)),
      commitMessage: `sdlc(${view.id}): harvest ${id} (draft)`,
      trailers: trailersFor(events, ctx.actor),
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

import { stringifyJson, stringifyYaml, type EvalCase, type Finding } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult } from "../writeplan.js";
import { createChange } from "./create-change.js";
import type { TransitionContext } from "./context.js";

function findingPath(id: string): string {
  return `sdlc/security/findings/${id}.yaml`;
}

function requireSecurity(repo: Repo, ctx: TransitionContext): TransitionResult | null {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng") && !holdsRole(repo.config, ctx.actor.id, "security")) {
    return refuse("finding.not-owner", `${ctx.actor.id} holds neither eng nor security`);
  }
  return null;
}

function openFinding(repo: Repo, id: string): Finding | TransitionResult {
  const f = repo.findings.find((x) => x.id === id);
  if (!f) return refuse("finding.missing", `${id} not found`);
  if (f.status !== "new") return refuse("finding.not-new", `${id} is ${f.status}; only new findings are routed`);
  return f;
}

/** Patch → PR gate: bounded fix, no new change; the review gate decides (spec §4.7). */
export function patchFinding(repo: Repo, id: string, ctx: TransitionContext, pr?: { number?: number; url?: string }): TransitionResult {
  const denied = requireSecurity(repo, ctx);
  if (denied) return denied;
  const f = openFinding(repo, id);
  if ("ok" in f) return f;
  const next: Finding = { ...f, status: "patch_pr", ...(pr ? { patchPr: pr } : {}) };
  return {
    ok: true,
    plan: {
      changeId: null,
      files: [{ path: findingPath(id), content: stringifyYaml(next) }],
      events: [],
      commitMessage: `sdlc(${id}): patch in PR gate`,
      trailers: { "SDLC-Actor": `human:${ctx.actor.id}` },
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

/**
 * Wider than one patch → intent.md (acceptance d): new change at stage 1 with
 * an intent drafted from the finding, the finding marked escalated, and a
 * draft eval case for the vulnerability class.
 */
export function escalateFinding(repo: Repo, id: string, ctx: TransitionContext): TransitionResult {
  const denied = requireSecurity(repo, ctx);
  if (denied) return denied;
  const f = openFinding(repo, id);
  if ("ok" in f) return f;
  const body = `# Intent: ${f.title}

## Problem
${f.desc}

Scanner ${f.scannerId} reported ${id} (${f.sev}, confidence ${f.conf}) in ${f.repo}.

## Proposed outcome
The vulnerability class behind ${id} is closed across ${f.repo}, not only at the reported site, and an eval case guards it.

## Affected users and systems
${f.repo}

## Constraints
Fixes reach production only through PR review and branch protection; the proposing agent cannot approve its own fix.

## Open questions
Which other sites share this pattern?
`;
  const created = createChange(repo, { title: f.title, kind: "fix", risk: "high", origin: { type: "security", ref: id }, intentBody: body }, ctx);
  if (!created.ok) return created;
  const plan = created.plan;
  const changeId = plan.changeId ?? "";
  const next: Finding = { ...f, status: "escalated", escalatedTo: changeId };
  plan.files.push({ path: findingPath(id), content: stringifyYaml(next) });
  const caseId = `CASE-${id}`;
  const evalCase: EvalCase = {
    schema: 1,
    id: caseId,
    prompt: `Vulnerability class: ${f.title}. Verify no instance remains in ${f.repo}.`,
    checks: [],
    source: { type: "change", ref: changeId },
    owner: ctx.actor.id,
    added: ctx.now,
    status: "draft",
    paths: [],
  };
  plan.files.push({ path: `evals/cases/${caseId}.json`, content: stringifyJson(evalCase) });
  plan.commitMessage = `sdlc(${changeId}): escalate ${id} → intent.md`;
  return { ok: true, plan };
}

export function dismissFinding(repo: Repo, id: string, reason: string, ctx: TransitionContext): TransitionResult {
  const denied = requireSecurity(repo, ctx);
  if (denied) return denied;
  if (reason.trim() === "") return refuse("dismissal.reason-missing", "a dismissal needs a reason");
  const f = openFinding(repo, id);
  if ("ok" in f) return f;
  const next: Finding = { ...f, status: "dismissed", dismissal: { by: ctx.actor.id, reason: reason.trim(), at: ctx.now } };
  return {
    ok: true,
    plan: {
      changeId: null,
      files: [{ path: findingPath(id), content: stringifyYaml(next) }],
      events: [],
      commitMessage: `sdlc(${id}): dismiss — ${reason.trim()}`,
      trailers: { "SDLC-Actor": `human:${ctx.actor.id}` },
      actor: { type: "human", id: ctx.actor.id },
    },
  };
}

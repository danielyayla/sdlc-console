import type { Diagnostic } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import { eventsNamed, eventsOfCycle, lastEvent } from "../events.js";
import type { ChangeFiles, Repo } from "../repo.js";
import { isDowngrade } from "../modes.js";
import { normalizeReason } from "../proposals.js";
import { gateOwner, STAGES } from "../stages.js";
import { environmentByName, holdsProductionGate, productionEnvironment } from "../config.js";

/** A diagnostic with the engine's blocking verdict (blueprint §11.1). */
export interface RuleDiagnostic extends Diagnostic {
  blocking: boolean;
  changeId?: string;
}

export function rule(d: Omit<RuleDiagnostic, "blocking">): RuleDiagnostic {
  return { ...d, blocking: d.severity === "error" };
}

function block(changeId: string | undefined, path: string, id: string, message: string): RuleDiagnostic {
  return changeId === undefined
    ? { path, severity: "error", rule: id, message, blocking: true }
    : { path, severity: "error", rule: id, message, blocking: true, changeId };
}

function warn(changeId: string | undefined, path: string, id: string, message: string): RuleDiagnostic {
  return changeId === undefined
    ? { path, severity: "warning", rule: id, message, blocking: false }
    : { path, severity: "warning", rule: id, message, blocking: false, changeId };
}

/** Rules over one change: parse errors, derivation errors, and the §11.1 rows that need no adapter. */
export function changeRules(repo: Repo, files: ChangeFiles, view: ChangeView): RuleDiagnostic[] {
  const out: RuleDiagnostic[] = [];
  const id = files.id;
  const dir = files.dir;

  for (const d of files.diagnostics) out.push({ ...rule(d), changeId: id });
  for (const d of view.validationErrors) {
    if (!files.diagnostics.includes(d)) out.push({ ...rule(d), changeId: id });
  }
  if (!files.change) return out;
  const change = files.change;
  const events = eventsOfCycle(files.events, change.cycle);

  // artifact completeness: derivation keeps the gate closed on an incomplete artifact,
  // so an accepted gate whose artifact is still incomplete means the ledger was hand-edited
  for (const s of STAGES) {
    if (s.gate === null || !view.acceptedGates.includes(s.gate)) continue;
    const parsed = { intent: files.intent, spec: files.spec, plan: files.plan, incident: files.incident, evals: null, pr: null }[s.artifact];
    if (parsed && !parsed.complete) {
      const which = [...parsed.missingSections, ...parsed.emptySections].join(", ");
      out.push(block(id, `${dir}/${s.file}`, "gate.accepted-incomplete", `gate ${s.gate} was accepted on an incomplete ${s.file}: ${which}`));
    }
  }

  // SHA chaining
  const acc1 = lastEvent(events, "gate.accepted", (e) => e.data.gate === 1);
  const acc2 = lastEvent(events, "gate.accepted", (e) => e.data.gate === 2);
  if (files.spec && acc1 && files.spec.frontMatter.intent_sha !== acc1.data.artifactSha) {
    out.push(block(id, `${dir}/spec.md`, "chain.spec.intent_sha", `spec.md intent_sha ${files.spec.frontMatter.intent_sha.slice(0, 7)} does not match the accepted intent ${acc1.data.artifactSha.slice(0, 7)}`));
  }
  if (files.plan && acc2 && files.plan.frontMatter.spec_sha !== acc2.data.artifactSha) {
    const have = files.plan.frontMatter.spec_sha?.slice(0, 7) ?? "null";
    out.push(block(id, `${dir}/plan.md`, "chain.plan.spec_sha", `plan.md spec_sha ${have} does not match the accepted spec ${acc2.data.artifactSha.slice(0, 7)}`));
  }
  if (acc1 && files.shas["intent.md"] && files.shas["intent.md"] !== acc1.data.artifactSha) {
    out.push(warn(id, `${dir}/intent.md`, "chain.intent.modified", "intent.md was modified after gate 1 accepted it (rework)"));
  }
  if (acc2 && files.shas["spec.md"] && files.shas["spec.md"] !== acc2.data.artifactSha) {
    out.push(warn(id, `${dir}/spec.md`, "chain.spec.modified", "spec.md was modified after gate 2 accepted it (rework)"));
  }

  // gate ownership: every accept / send-back actor holds the owning role
  if (repo.config.present) {
    for (const e of [...eventsNamed(files.events, "gate.accepted"), ...eventsNamed(files.events, "gate.sent_back")]) {
      const owner = gateOwner(e.data.gate, change.risk, repo.config.codeHost);
      const ok = holdsRole(repo.config, e.actor.id, owner.role) || (e.data.gate === 3 && holdsRole(repo.config, e.actor.id, "tech_lead"));
      if (!ok) {
        out.push(block(id, `${dir}/log.jsonl`, "gate.actor-not-owner", `${e.actor.id} recorded ${e.event} on gate ${e.data.gate} but does not hold the ${owner.role} role`));
      }
    }
  }

  // the production gate (3.6): its decision is a human holding the gate's role, and a production deployment rests on that decision and a rehearsed rollback
  if (repo.config.present && repo.config.environments.length > 0) {
    for (const e of eventsNamed(files.events, "deploy.authorized")) {
      const env = environmentByName(repo.config, e.data.env);
      if (!env || env.kind !== "production") {
        out.push(block(id, `${dir}/log.jsonl`, "deploy.authorized.env", `${e.actor.id} authorized a deploy to ${e.data.env}, which is not a production environment in sdlc/config.yaml`));
        continue;
      }
      if (!holdsProductionGate(repo.config, e.actor.id, env)) out.push(block(id, `${dir}/log.jsonl`, "deploy.actor-not-owner", `${e.actor.id} authorized a deploy to ${e.data.env} but does not hold ${env.gateRoles.join(" or ")}, the role that owns the production gate`));
    }
    const production = productionEnvironment(repo.config);
    for (const d of files.deploy?.environments ?? []) {
      const env = environmentByName(repo.config, d.env);
      if (!env || env.kind !== "production") continue;
      if (d.status !== "succeeded" && d.status !== "running") continue;
      if (d.actor.type !== "human") out.push(block(id, `${dir}/deploy.yaml`, "deploy.production-not-human", `${d.env} was deployed at ${d.sha.slice(0, 7)} by ${d.actor.type}:${d.actor.id}; production deploys are a person's gate decision`));
      const authorized = eventsNamed(files.events, "deploy.authorized").some((e) => e.data.env === d.env && (e.data.sha === undefined || e.data.sha === d.sha) && e.actor.id === (d.authorizedBy ?? e.actor.id));
      if (!authorized) out.push(block(id, `${dir}/deploy.yaml`, "deploy.production-unauthorized", `${d.env} was deployed at ${d.sha.slice(0, 7)} with no deploy.authorized decision for it on the ledger`));
      const rehearsed = (files.deploy?.rehearsals ?? []).some((r) => r.status === "succeeded" && (environmentByName(repo.config, r.env)?.kind ?? r.kind) !== "production" && (r.sha === d.sha || (files.pr?.headSha !== undefined && r.sha === files.pr.headSha)));
      if (production && !rehearsed) out.push(block(id, `${dir}/deploy.yaml`, "deploy.production-unrehearsed", `${d.env} was deployed at ${d.sha.slice(0, 7)} with no succeeded rollback rehearsal at that commit in a non-production environment`));
    }
    for (const r of files.deploy?.rehearsals ?? []) {
      if ((environmentByName(repo.config, r.env)?.kind ?? r.kind) === "production") out.push(block(id, `${dir}/deploy.yaml`, "rehearsal.production", `a rollback rehearsal is recorded against ${r.env}, a production environment; rehearsals belong to non-production environments`));
    }
  }

  // autonomy only goes down (P9): an override that raises a session's mode is not a decision the ledger accepts
  for (const e of eventsNamed(files.events, "override.mode")) {
    if (!isDowngrade(e.data.from, e.data.to)) out.push(block(id, `${dir}/log.jsonl`, "override.upward", `${e.actor.id} recorded mode ${e.data.from} → ${e.data.to}; autonomy is derived and can only be reduced`));
  }

  // linked mode: past an artifact's stage the record must be present
  for (const s of STAGES) {
    if (s.gate === null) continue;
    if (repo.config.records[s.artifact] === "linked" && view.acceptedGates.includes(s.gate) && !change.record) {
      out.push(block(id, `${dir}/change.yaml`, "linked.record-missing", `${s.file} is linked to an external record but change.yaml has no record`));
    }
  }

  // tasks
  if (files.tasks) {
    const seen = new Map<string, string>();
    for (const t of files.tasks.tasks) {
      if (t.state === "running" && !(t.target && t.target.trim() !== "")) {
        out.push(block(id, `${dir}/tasks.yaml`, "tasks.target.missing", `task ${t.id} is running without a target`));
      }
      if (t.sequential) continue;
      for (const f of t.files) {
        const other = seen.get(f);
        if (other && other !== t.id) {
          out.push(block(id, `${dir}/tasks.yaml`, "tasks.files.overlap", `tasks ${other} and ${t.id} both touch ${f} but are not sequential`));
        }
        seen.set(f, t.id);
      }
    }
    if (files.tasks.changeId !== id) out.push(block(id, `${dir}/tasks.yaml`, "tasks.change-id", `tasks.yaml belongs to ${files.tasks.changeId}`));
  }

  // a lift is single-use per file per change (FR-22): a second freeze.lifted on the same path is not a decision the ledger accepts
  {
    const seenLift = new Map<string, string>();
    for (const e of eventsNamed(files.events, "freeze.lifted")) {
      const key = `${e.cycle}:${e.data.path}`;
      const first = seenLift.get(key);
      if (first) out.push(block(id, `${dir}/log.jsonl`, "freeze.lifted-twice", `${e.actor.id} lifted the test freeze on ${e.data.path} again (first by ${first}); a lift is once per file per change`));
      else seenLift.set(key, e.actor.id);
    }
  }

  // repro consistency
  if (change.repro?.state === "committed") {
    if (!change.repro.sha) out.push(block(id, `${dir}/change.yaml`, "repro.sha.missing", "repro state is committed but no sha is recorded"));
    if (!files.repro) out.push(warn(id, `${dir}/evals/repro.json`, "repro.proof.missing", "repro committed but evals/repro.json is missing"));
    if (change.kind !== "fix") out.push(block(id, `${dir}/change.yaml`, "repro.not-fix", "repro block on a feature change"));
  }

  // incident loop: INC case must be active before the change passes stage 4 again
  if (view.incCase && view.stage >= 5 && view.incCase.status !== "active") {
    out.push(block(id, `evals/cases/${view.incCase.id}.json`, "inc-case.inactive", `${id} is past stage 4 but ${view.incCase.id} is ${view.incCase.status}`));
  }

  // staleness (advisory)
  for (const doc of Object.values(view.docs)) {
    if (doc.state === "stale") out.push(warn(id, doc.path, "artifact.stale", `${doc.name} edited after acceptance / after the next artifact — counted as rework`));
  }
  return out;
}

/** Repo-level rules: eval cases, dismissals, config parse and lint warnings. */
export function repoRules(repo: Repo): RuleDiagnostic[] {
  const out: RuleDiagnostic[] = repo.diagnostics.map(rule);
  // records mode (FR-16): write-backs need a connector; linked mode needs an artifact commit to write back
  const rec = repo.config.records;
  const outside = STAGES.filter((s) => rec[s.artifact] !== "repo").map((s) => s.artifact);
  if (outside.length > 0 && !repo.rawConfig?.records?.connector) out.push(warn(undefined, "sdlc/config.yaml", "records.connector-missing", `records ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} external or linked but records.connector names no MCP server in .mcp.json — write-backs will fail until it does`));
  for (const a of ["evals", "pr"] as const) if (rec[a] === "linked") out.push(warn(undefined, "sdlc/config.yaml", "records.linked-unsupported", `records.${a} is linked but ${a} has no artifact commit to write back; it behaves as external`));
  for (const c of repo.evalCases) {
    if (c.status === "active" && c.checks.length === 0) {
      out.push(block(undefined, `evals/cases/${c.id}.json`, "eval-case.active-without-checks", `${c.id} is active but has no checks`));
    }
  }
  for (const r of repo.evalRuns) {
    // incomplete never counts as pass; a run file claiming pass below its own threshold was hand-edited
    if (r.verdict === "pass" && r.passRate < r.threshold) out.push(block(undefined, `evals/runs/${r.id}.json`, "eval-run.pass-below-threshold", `${r.id} is marked pass at ${Math.round(r.passRate * 100)}% below its threshold ${Math.round(r.threshold * 100)}%`));
  }
  if (repo.evalCases.filter((c) => c.status !== "retired").length < repo.config.thresholds.suiteMinSize) {
    out.push(warn(undefined, "evals/cases", "eval-suite.under-sized", `eval suite has ${repo.evalCases.length} cases; under-sized below ${repo.config.thresholds.suiteMinSize}`));
  }
  for (const t of repo.triage) {
    if (t.data.status === "dismissed" && !t.data.dismissal) out.push(block(undefined, t.path, "dismissal.reason-missing", `${t.data.id} is dismissed without a reason`));
  }
  for (const f of repo.findings) {
    if (f.status === "dismissed" && !f.dismissal) out.push(block(undefined, `sdlc/security/findings/${f.id}.yaml`, "dismissal.reason-missing", `${f.id} is dismissed without a reason`));
    if (f.status === "escalated" && !f.escalatedTo) out.push(block(undefined, `sdlc/security/findings/${f.id}.yaml`, "finding.escalated-without-change", `${f.id} is escalated but names no change`));
  }
  for (const p of repo.proposals) {
    if (p.status === "dismissed" && !p.dismissal) out.push(block(undefined, `sdlc/proposals/${p.id}.yaml`, "dismissal.reason-missing", `${p.id} is dismissed without a reason`));
  }
  const seenReason = new Map<string, string>();
  for (const p of repo.proposals) {
    if (p.reason === undefined) continue;
    const key = normalizeReason(p.reason);
    const other = seenReason.get(key);
    if (other) out.push(warn(undefined, `sdlc/proposals/${p.id}.yaml`, "proposal.reason-duplicate", `${p.id} answers the same reason as ${other} ("${key}"); a third occurrence counts onto one proposal, it does not file another`));
    else seenReason.set(key, p.id);
  }
  const hookNames = new Set((repo.settings?.hooks ?? []).map((h) => h.name));
  for (const s of repo.skills) {
    if (s.mustHold && !s.backedBy) out.push(warn(undefined, `.claude/skills/${s.name}/SKILL.md`, "skill.must-hold.advisory", `skill ${s.name} must hold but no hook backs it`));
    if (s.backedBy && repo.settings && !hookNames.has(s.backedBy)) out.push(warn(undefined, `.claude/skills/${s.name}/SKILL.md`, "skill.backed-by.unknown", `skill ${s.name} says it is backed by hook ${s.backedBy}, which is not in .claude/settings.json — advisory until the hook is installed`));
  }
  if (repo.config.present) {
    // 3.6: environment names are unique; a production gate nobody can open is a configuration gap, not a blocked deploy
    const seenEnv = new Set<string>();
    for (const env of repo.config.environments) {
      if (seenEnv.has(env.name)) out.push(block(undefined, "sdlc/config.yaml", "config.environment-duplicate", `environment ${env.name} is declared twice`));
      seenEnv.add(env.name);
      if (env.kind === "production" && !env.gateRoles.some((r) => repo.config.identities.some((i) => i.roles.includes(r)))) {
        out.push(warn(undefined, "sdlc/config.yaml", "config.production-gate-unowned", `environment ${env.name} is behind the production gate (${env.gateRoles.join(", ")}) but no identity holds that role`));
      }
    }
    const highRisk = [...repo.changes.values()].some((c) => c.change?.risk === "high");
    if (highRisk && !repo.config.identities.some((i) => i.roles.includes("tech_lead"))) {
      out.push(warn(undefined, "sdlc/config.yaml", "config.no-tech-lead", "a high-risk change exists but no identity holds tech_lead"));
    }
  }
  return out;
}

import type { Diagnostic } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import { eventsNamed, eventsOfCycle, lastEvent } from "../events.js";
import type { ChangeFiles, Repo } from "../repo.js";
import { isDowngrade } from "../modes.js";
import { gateOwner, STAGES } from "../stages.js";

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
  for (const s of repo.skills) {
    if (s.mustHold && !s.backedBy) out.push(warn(undefined, `.claude/skills/${s.name}/SKILL.md`, "skill.must-hold.advisory", `skill ${s.name} must hold but no hook backs it`));
  }
  if (repo.config.present) {
    const highRisk = [...repo.changes.values()].some((c) => c.change?.risk === "high");
    if (highRisk && !repo.config.identities.some((i) => i.roles.includes("tech_lead"))) {
      out.push(warn(undefined, "sdlc/config.yaml", "config.no-tech-lead", "a high-risk change exists but no identity holds tech_lead"));
    }
  }
  return out;
}

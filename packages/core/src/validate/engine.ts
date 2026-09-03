import { validate as validateSchema } from "@sdlc/schemas";
import { deriveChange } from "../derive.js";
import { loadRepo, type Repo } from "../repo.js";
import { applyWritePlan, type WritePlan } from "../writeplan.js";
import { changeRules, repoRules, type RuleDiagnostic } from "./rules.js";

export interface ValidationReport {
  diagnostics: RuleDiagnostic[];
  blocking: boolean;
  /** Per-change blocking counts for chips. */
  byChange: Record<string, number>;
}

function report(diagnostics: RuleDiagnostic[]): ValidationReport {
  const byChange: Record<string, number> = {};
  for (const d of diagnostics) {
    if (d.blocking && d.changeId) byChange[d.changeId] = (byChange[d.changeId] ?? 0) + 1;
  }
  return { diagnostics, blocking: diagnostics.some((d) => d.blocking), byChange };
}

/** Every rule over the whole tree (`sdlc validate`). */
export function validateTree(repo: Repo): ValidationReport {
  const out: RuleDiagnostic[] = repoRules(repo);
  for (const files of repo.changes.values()) {
    out.push(...changeRules(repo, files, deriveChange(repo, files)));
  }
  return report(out);
}

export function validateChange(repo: Repo, changeId: string): ValidationReport {
  const files = repo.changes.get(changeId);
  if (!files) {
    return report([{ path: `sdlc/changes/${changeId}`, severity: "error", rule: "change.missing", message: `${changeId} not found`, blocking: true, changeId }]);
  }
  return report(changeRules(repo, files, deriveChange(repo, files)));
}

/** Rules that need the previous tree: risk/kind immutability at stage ≥3, archived cycles untouched. */
export function validateDiff(before: Repo, after: Repo): ValidationReport {
  const out: RuleDiagnostic[] = [];
  for (const [id, prev] of before.changes) {
    const next = after.changes.get(id);
    if (!prev.change || !next?.change) continue;
    const view = deriveChange(before, prev);
    if (view.stage >= 3 && next.change.cycle === prev.change.cycle) {
      for (const field of ["risk", "kind"] as const) {
        if (prev.change[field] !== next.change[field]) {
          out.push({ path: `${prev.dir}/change.yaml`, severity: "error", rule: `change.${field}.immutable`, message: `${field} changed from ${prev.change[field]} to ${next.change[field]} while ${id} is at stage ${view.stage}`, blocking: true, changeId: id });
        }
      }
    }
    for (const n of prev.archivedCycles) {
      const prefix = `${prev.dir}/cycles/${n}/`;
      for (const [path, file] of before.tree.files) {
        if (!path.startsWith(prefix)) continue;
        const now = after.tree.files.get(path);
        if (!now || now.sha !== file.sha) {
          out.push({ path, severity: "error", rule: "cycle.archive.modified", message: `archived cycle ${n} of ${id} was modified`, blocking: true, changeId: id });
        }
      }
    }
    const prevEvents = new Map(prev.events.map((e) => [e.id, JSON.stringify(e)]));
    for (const [eid, json] of prevEvents) {
      const now = next.events.find((e) => e.id === eid);
      if (!now) out.push({ path: `${prev.dir}/log.jsonl`, severity: "error", rule: "log.event.removed", message: `event ${eid} disappeared from the ledger`, blocking: true, changeId: id });
      else if (JSON.stringify(now) !== json) out.push({ path: `${prev.dir}/log.jsonl`, severity: "error", rule: "log.event.modified", message: `event ${eid} was rewritten`, blocking: true, changeId: id });
    }
  }
  for (const id of before.changes.keys()) {
    if (!after.changes.has(id)) out.push({ path: `sdlc/changes/${id}`, severity: "error", rule: "change.removed", message: `${id} was deleted; changes are closed, never removed`, blocking: true, changeId: id });
  }
  return report(out);
}

/** Duplicate ids across refs (default branch + local branches). */
export function validateIds(idsByRef: Record<string, readonly string[]>): ValidationReport {
  const out: RuleDiagnostic[] = [];
  const owners = new Map<string, Set<string>>();
  for (const [ref, ids] of Object.entries(idsByRef)) {
    for (const id of ids) owners.set(id, new Set([...(owners.get(id) ?? []), ref]));
  }
  for (const [id, refs] of owners) {
    if (refs.size > 1) {
      // the same change on several branches is normal only when it exists on the default branch too
      const onDefault = refs.has("main") || refs.has("master") || refs.has("HEAD");
      if (!onDefault) {
        out.push({ path: `sdlc/changes/${id}`, severity: "error", rule: "change.id.duplicate", message: `${id} was created independently on ${[...refs].join(" and ")}`, blocking: true, changeId: id });
      }
    }
  }
  return report(out);
}

/**
 * Pre-commit validation of a write-plan: every event must validate (an
 * agent-authored gate.accepted fails here), and the tree after the plan must
 * be clean for the changes it touches.
 */
export function validateWritePlan(repo: Repo, plan: WritePlan): ValidationReport {
  const out: RuleDiagnostic[] = [];
  for (const { changeId, event } of plan.events) {
    const r = validateSchema("event", event, `sdlc/changes/${changeId}/log.jsonl`);
    if (!r.ok) out.push(...r.diagnostics.map((d) => ({ ...d, blocking: true, changeId })));
  }
  const after = loadRepo(applyWritePlan(repo.tree, plan));
  const touched = new Set<string>([...(plan.changeId ? [plan.changeId] : []), ...plan.events.map((e) => e.changeId)]);
  for (const f of plan.files) {
    const m = /^sdlc\/changes\/(CHG-\d{4})\//.exec(f.path);
    if (m?.[1]) touched.add(m[1]);
  }
  for (const id of touched) {
    const files = after.changes.get(id);
    if (!files) continue;
    out.push(...changeRules(after, files, deriveChange(after, files)));
  }
  out.push(...validateDiff(repo, after).diagnostics);
  return report(out);
}

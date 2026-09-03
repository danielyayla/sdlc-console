import { commitTrailers, fileHistory } from "@sdlc/adapter-git";
import { deriveChange, describeEvent, eventsNamed, gateOwner, holdsRole, validateChange } from "@sdlc/core";
import type { Event } from "@sdlc/schemas";
import { loadCommitted, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface AuditStep {
  cycle: number;
  seq: number;
  ts: string;
  actor: string;
  role: string | null;
  kind: "asked" | "produced" | "decided" | "system" | "other";
  text: string;
  commit: string | null;
  ok: boolean;
  problems: string[];
}

export interface AuditReport {
  id: string;
  cycle: number;
  stage: number;
  clean: boolean;
  steps: AuditStep[];
  breaks: string[];
}

function actorLabel(e: Event): string {
  return e.actor.type === "human" ? e.actor.id : e.actor.type === "agent" ? `agent:${e.actor.id}${e.actor.session ? `@${e.actor.session}` : ""}` : `system:${e.actor.id}`;
}

function kindOf(e: Event): AuditStep["kind"] {
  if (e.event === "change.created" || e.event === "question") return "asked";
  if (e.event === "artifact.committed" || e.event === "plan.drafted" || e.event === "plan.final" || e.event === "round") return "produced";
  if (e.event === "gate.accepted" || e.event === "gate.sent_back" || e.event === "pr.merged" || e.event === "repro.confirmed" || e.event === "tasks.confirmed") return "decided";
  if (e.actor.type === "system") return "system";
  return "other";
}

/**
 * `sdlc audit <CHG>`: render the chain (who asked, what the agent produced,
 * who approved) and verify it: human gate actors holding the owning role,
 * SHA chaining, commit trailers naming ledger events, manifests on
 * agent-produced artifacts. Any break → clean=false.
 */
export async function auditCommand(ctx: CliContext, id: string, ref = "HEAD"): Promise<AuditReport> {
  const { repo } = await loadCommitted(ctx, ref);
  const files = repo.changes.get(id);
  if (!files) throw new CliError(`${id} not found`);
  const view = deriveChange(repo, files);
  const breaks: string[] = [];
  for (const d of validateChange(repo, id).diagnostics.filter((x) => x.blocking)) breaks.push(`${d.rule}: ${d.message}`);

  const history = await fileHistory(ctx.root, `sdlc/changes/${id}/log.jsonl`, ref);
  const commitByEvent = new Map<string, string>();
  const trailerActorByEvent = new Map<string, string>();
  for (const c of history) {
    const t = await commitTrailers(ctx.root, c.sha);
    const evId = t["SDLC-Event"];
    if (evId) {
      commitByEvent.set(evId, c.sha);
      if (t["SDLC-Actor"]) trailerActorByEvent.set(evId, t["SDLC-Actor"]);
    }
  }
  const eventIds = new Set(files.events.map((e) => e.id));
  for (const [evId, sha] of commitByEvent) {
    if (!eventIds.has(evId)) breaks.push(`commit ${sha.slice(0, 7)} names event ${evId} which is not in the ledger`);
  }

  const steps: AuditStep[] = files.events.map((e) => {
    const problems: string[] = [];
    const commit = commitByEvent.get(e.id) ?? null;
    if (e.event === "gate.accepted" || e.event === "gate.sent_back") {
      if (e.actor.type !== "human") problems.push("gate decision by a non-human actor");
      const owner = gateOwner(e.data.gate, view.risk, repo.config.codeHost);
      if (repo.config.present && !holdsRole(repo.config, e.actor.id, owner.role) && !(e.data.gate === 3 && holdsRole(repo.config, e.actor.id, "tech_lead"))) {
        problems.push(`${e.actor.id} does not hold ${owner.role}`);
      }
      if (!commit) problems.push("no commit carries an SDLC-Event trailer for this decision");
      const ta = trailerActorByEvent.get(e.id);
      if (ta && ta !== `human:${e.actor.id}`) problems.push(`commit trailer actor ${ta} ≠ event actor ${e.actor.id}`);
    }
    if (e.event === "artifact.committed" && e.actor.type === "agent") {
      const artifact = { 0: files.intent, 1: files.spec, 2: files.plan, 5: files.incident }[e.data.artifact as 0 | 1 | 2 | 5];
      if (artifact && !artifact.frontMatter.context_manifest) problems.push("agent-produced artifact has no context_manifest");
    }
    return {
      cycle: e.cycle,
      seq: e.seq,
      ts: e.ts,
      actor: actorLabel(e),
      role: e.actor.role ?? null,
      kind: kindOf(e),
      text: describe(e),
      commit,
      ok: problems.length === 0,
      problems,
    };
  });
  for (const s of steps) for (const p of s.problems) breaks.push(`seq ${s.seq}: ${p}`);

  // chaining across artifacts, restated for the report
  const acc1 = eventsNamed(files.events, "gate.accepted").find((e) => e.data.gate === 1 && e.cycle === view.cycle);
  if (files.spec && acc1 && files.spec.frontMatter.intent_sha !== acc1.data.artifactSha) breaks.push("spec.md intent_sha does not chain to the accepted intent");
  const acc2 = eventsNamed(files.events, "gate.accepted").find((e) => e.data.gate === 2 && e.cycle === view.cycle);
  if (files.plan && acc2 && files.plan.frontMatter.spec_sha !== acc2.data.artifactSha) breaks.push("plan.md spec_sha does not chain to the accepted spec");

  const unique = [...new Set(breaks)];
  return { id, cycle: view.cycle, stage: view.stage, clean: unique.length === 0, steps, breaks: unique };
}

function describe(e: Event): string {
  return describeEvent(e);
}

export function renderAudit(r: AuditReport): string {
  const lines = [`${r.id} · cycle ${r.cycle} · stage ${r.stage}`];
  let cycle = 0;
  for (const s of r.steps) {
    if (s.cycle !== cycle) {
      cycle = s.cycle;
      lines.push(`— cycle ${cycle} —`);
    }
    const mark = s.ok ? "✓" : "✗";
    const who = s.role ? `${s.actor} (${s.role})` : s.actor;
    const commit = s.commit ? ` ← ${s.commit.slice(0, 7)}` : "";
    lines.push(`${mark} ${s.ts}  ${s.kind.padEnd(8)} ${who}: ${s.text}${commit}`);
    for (const p of s.problems) lines.push(`    ! ${p}`);
  }
  lines.push(r.clean ? "chain: clean" : `chain: BROKEN (${r.breaks.length})`);
  for (const b of r.breaks) lines.push(`  ! ${b}`);
  return lines.join("\n");
}

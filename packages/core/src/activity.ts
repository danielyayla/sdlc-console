import type { Event } from "@sdlc/schemas";
import { STAGES } from "./stages.js";

export interface ActivityEntry {
  id: string;
  ts: string;
  actor: "human" | "agent" | "system";
  actorId: string;
  role: string | null;
  event: Event["event"];
  text: string;
}

const ARTIFACT_FILE = STAGES.map((s) => (s.n === 4 ? "evals" : s.file));

function gateArtifact(gate: number): string {
  const idx = { 1: 0, 2: 1, 3: 2, 5: 4, 6: 5 }[gate] ?? 0;
  return ARTIFACT_FILE[idx] ?? "artifact";
}

/** One human-readable line per event (spec §4.2 activity feed). */
export function describeEvent(e: Event): string {
  switch (e.event) {
    case "artifact.committed":
      return `committed ${ARTIFACT_FILE[e.data.artifact] ?? e.data.path}`;
    case "gate.accepted":
      return e.data.source === "pr.merge"
        ? `accepted ${gateArtifact(e.data.gate)} via PR (gate ${e.data.gate})`
        : `accepted ${gateArtifact(e.data.gate)} (gate ${e.data.gate})`;
    case "gate.sent_back":
      return `sent ${gateArtifact(e.data.gate)} back with feedback: ${e.data.feedback}`;
    case "stage.entered":
      return `entered stage ${e.data.stage} · ${STAGES[e.data.stage - 1]?.name ?? ""}`.trim();
    case "plan.drafted":
      return `drafted plan.md rev ${e.data.rev}`;
    case "plan.final":
      return `marked plan.md rev ${e.data.rev} final`;
    case "question":
      return e.data.answer ? `asked: ${e.data.text} — ${e.data.answer}` : `asked: ${e.data.text}`;
    case "tasks.proposed":
      return `proposed ${e.data.tasks.length} task${e.data.tasks.length === 1 ? "" : "s"}`;
    case "tasks.confirmed":
      return `confirmed tasks ${e.data.taskIds.join(", ")}`;
    case "session.started":
      return `session ${e.data.session} started (${e.data.mode})${e.data.task ? ` on ${e.data.task}` : ""}`;
    case "session.stopped":
      return `session ${e.data.session} ${e.data.reason}`;
    case "round": {
      const parts = e.data.results.map((r) => `${r.name} ${r.pass ? "✓" : "✗"}`).join(" ");
      return `round ${e.data.n} · ${parts}`;
    }
    case "hook.blocked":
      return `hook ${e.data.hook} blocked ${e.data.path ? `${e.data.path}: ` : ""}${e.data.reason}`;
    case "hook.allowed":
      return `hook ${e.data.hook} allowed${e.data.path ? ` ${e.data.path}` : ""}`;
    case "verifier.result":
      return `verifier ran=${e.data.ran} saw=${e.data.saw} mismatch=${e.data.mismatch}`;
    case "repro.failed":
      return `repro test fails: ${e.data.failureReason}`;
    case "repro.confirmed":
      return `confirmed repro test ${e.data.testPath} @ ${e.data.sha.slice(0, 7)}`;
    case "freeze.lifted":
      return `lifted test freeze for ${e.data.path}: ${e.data.reason}`;
    case "evals.green":
      return `evals green (${e.data.passed}/${e.data.total})`;
    case "evals.red":
      return `evals red (${e.data.passed}/${e.data.total})`;
    case "pr.opened":
      return e.data.artifact !== undefined ? `${["intent.md", "spec.md", "plan.md", "evals", "pr.yaml", "incident.md"][e.data.artifact] ?? "artifact"} in review${e.data.number ? ` as PR #${e.data.number}` : ""}` : `PR opened${e.data.number ? ` #${e.data.number}` : ""}`;
    case "pr.merged":
      return `PR merged${e.data.number ? ` #${e.data.number}` : ""}`;
    case "review.finding":
      return `review finding (${e.data.severity}): ${e.data.title}`;
    case "deploy.authorized":
      return `authorized deploy to ${e.data.env}`;
    case "deploy.started":
      return `deploy to ${e.data.env} started`;
    case "deploy.finished":
      return `deploy to ${e.data.env} finished`;
    case "deploy.failed":
      return `deploy to ${e.data.env} failed${e.data.reason ? `: ${e.data.reason}` : ""}`;
    case "record.writeback.ok":
      return `wrote back to ${e.data.system} ${e.data.id}`;
    case "record.writeback.failed":
      return `write-back to ${e.data.system} failed · retry`;
    case "override.mode":
      return `mode ${e.data.from} → ${e.data.to}${e.data.reason ? `: ${e.data.reason}` : ""}`;
    case "consult.tech_lead":
      return `tech lead consulted${e.data.note ? `: ${e.data.note}` : ""}`;
    case "note":
      return e.data.text;
    case "change.created":
      return `created change${e.data.origin ? ` via ${e.data.origin}` : ""}`;
    case "change.closed":
      return `closed: ${e.data.reason}`;
    case "cycle.archived":
      return `archived cycle ${e.data.cycle} under ${e.data.into}`;
  }
}

/** Newest first. */
export function activityFeed(events: readonly Event[]): ActivityEntry[] {
  return [...events]
    .reverse()
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      actor: e.actor.type,
      actorId: e.actor.id,
      role: e.actor.role ?? null,
      event: e.event,
      text: describeEvent(e),
    }));
}

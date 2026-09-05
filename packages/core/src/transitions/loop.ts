import { stringifyFrontMatter, stringifyJson, stringifyYaml, type Change, type EvalCase } from "@sdlc/schemas";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { filesUnder, readFile } from "../tree.js";
import { refuse, type FileWrite, type TransitionResult, type WritePlan } from "../writeplan.js";
import { blobShaOf, checkGate, EventBuilder, trailersFor, type TransitionContext } from "./context.js";

const KEEP = new Set(["change.yaml", "log.jsonl"]);

/** Map incident sections onto the intent template (FR-14). */
export function intentFromIncident(title: string, incidentBody: string): string {
  const section = (name: string): string => {
    const m = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, "m").exec(incidentBody);
    const text = m?.[1]?.trim() ?? "";
    return text === "" ? `<from incident: ${name}>` : text;
  };
  return `# Intent: ${title}

## Problem
${section("Anomaly and evidence")}

## Proposed outcome
${section("Proposed outcome")}

## Affected users and systems
${section("Affected systems")}

## Constraints
<carried from the previous cycle>

## Open questions
${section("Open questions")}
`;
}

/**
 * Gate 6 accept: same change, `cycle+1`, previous artifacts archived under
 * `cycles/<n>/`, new intent seeded from the incident, draft `INC-` eval case
 * the change must activate before it can pass stage 4 again (decisions Q2).
 */
export function loop(repo: Repo, view: ChangeView, ctx: TransitionContext): TransitionResult {
  const check = checkGate(repo, view, 6, ctx);
  if (!check.ok) return check.result;
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  if (!files.incident) return refuse("incident.missing", "incident.md is missing or invalid", `${files.dir}/incident.md`);
  const n = files.change.cycle;
  const next = n + 1;
  const dir = files.dir;
  const writes: FileWrite[] = [];

  // archive every artifact of the closing cycle
  for (const path of filesUnder(repo.tree, dir)) {
    const rel = path.slice(dir.length + 1);
    if (KEEP.has(rel) || rel.startsWith("cycles/")) continue;
    const content = readFile(repo.tree, path)?.content ?? "";
    writes.push({ path, content: null });
    writes.push({ path: `${dir}/cycles/${n}/${rel}`, content });
  }

  const change: Change = { ...files.change, cycle: next, kind: "fix", repro: null, closed: null };
  writes.push({ path: `${dir}/change.yaml`, content: stringifyYaml(change) });

  const incidentTitle = (files.incident.title ?? "").replace(/^Incident:\s*/, "") || view.title;
  const intent = stringifyFrontMatter(
    { id: view.id, artifact: "intent", cycle: next, author: ctx.actor.id, created: ctx.now, status: "draft", schema: 1 },
    intentFromIncident(incidentTitle, files.incident.body),
  );
  writes.push({ path: `${dir}/intent.md`, content: intent });

  const caseId = `INC-${view.id}-${n}`;
  const paths = files.plan?.files.map((f) => f.path) ?? files.runs.at(-1)?.fileSet ?? [];
  const incCase: EvalCase = {
    schema: 1,
    id: caseId,
    prompt: `Reproduce and verify the fix for: ${incidentTitle}`,
    checks: [],
    source: { type: "incident", ref: view.id },
    owner: ctx.actor.id,
    added: ctx.now,
    status: "draft",
    paths,
  };
  writes.push({ path: `evals/cases/${caseId}.json`, content: stringifyJson(incCase) });

  const ev = new EventBuilder(ctx, files, view.id);
  const sha = view.docs[5].sha ?? "0".repeat(40);
  const events = [
    ev.human("gate.accepted", check.role, n, { gate: 6, artifactSha: sha, source: ctx.source ?? "cli" }),
    ev.system("cycle.archived", next, { cycle: n, into: `cycles/${n}` }),
    ev.system("artifact.committed", next, { artifact: 0, path: `${dir}/intent.md`, sha: blobShaOf(ctx, intent) }),
    ev.system("stage.entered", next, { stage: 1 }),
  ];
  const plan: WritePlan = {
    changeId: view.id,
    files: writes,
    events: events.map((e) => ev.write(e)),
    commitMessage: `sdlc(${view.id}): accept incident.md (gate 6) → cycle ${next}`,
    trailers: trailersFor(events, ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: check.role },
  };
  return { ok: true, plan };
}

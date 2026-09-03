import { parseFrontMatter, stringifyFrontMatter, stringifyYaml, type GateNumber } from "@sdlc/schemas";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { ARTIFACT_INDEX_FOR_GATE, gateDefs, stageDef } from "../stages.js";
import { readFile } from "../tree.js";
import { refuse, type FileWrite, type TransitionResult, type WritePlan } from "../writeplan.js";
import { checkGate, EventBuilder, trailersFor, type TransitionContext } from "./context.js";
import { loop } from "./loop.js";

/**
 * Accept a gate (FR-21). Gate 6 is the loop. Gate 5 in local mode records the
 * merge the adapter already performed (`ctx.mergeSha`). Never callable by an
 * agent: there is no agent-shaped context.
 */
export function accept(repo: Repo, view: ChangeView, gate: GateNumber, ctx: TransitionContext): TransitionResult {
  if (gate === 6) return loop(repo, view, ctx);
  const check = checkGate(repo, view, gate, ctx);
  if (!check.ok) return check.result;
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const idx = ARTIFACT_INDEX_FOR_GATE[gate];
  const doc = view.docs[idx];
  const stage = stageDef(gate);
  const artifactName = stage.artifact;
  if (repo.config.records[artifactName] === "linked" && !view.record) {
    return refuse("gate.linked.record-missing", `${artifactName} is linked to an external record; accept is blocked until the record id and commit SHA are present`, doc.path);
  }
  const artifactFiles = { 1: files.intent, 2: files.spec, 3: files.plan, 5: null, 6: files.incident }[gate];
  if (artifactFiles && !artifactFiles.complete) {
    const missing = [...artifactFiles.missingSections, ...artifactFiles.emptySections];
    return refuse("gate.artifact-incomplete", `${doc.name} is incomplete: ${missing.join(", ")}`, doc.path);
  }
  const sha = doc.sha ?? "0".repeat(40);
  const dir = files.dir;
  const cycle = files.change.cycle;
  const ev = new EventBuilder(ctx, files, view.id);
  const writes: FileWrite[] = [];
  const events = [];

  events.push(ev.human("gate.accepted", check.role, cycle, { gate, artifactSha: sha, source: ctx.source ?? "cli" }));

  if (gate === 3) {
    const planText = readFile(repo.tree, `${dir}/plan.md`)?.content ?? "";
    const split = parseFrontMatter(planText, `${dir}/plan.md`);
    if (split.ok && split.value) {
      const data = { ...split.value.data, accepted_by: ctx.actor.id, accepted_at: ctx.now };
      writes.push({ path: `${dir}/plan.md`, content: stringifyFrontMatter(data, split.value.body) });
    }
  }

  if (gate === 5) {
    if (!files.pr) return refuse("pr.missing", "pr.yaml is missing", `${dir}/pr.yaml`);
    if (!ctx.mergeSha) return refuse("merge.sha-missing", "gate 5 needs the merge commit sha (the adapter merges first)");
    if (repo.config.codeHost === "github" && ctx.source !== "pr.merge") return refuse("gate.via-code-host", "in github mode gate 5 is the pull request merge (source pr.merge)");
    const merged = { ...files.pr, mergedAt: ctx.now, mergeSha: ctx.mergeSha };
    writes.push({ path: `${dir}/pr.yaml`, content: stringifyYaml(merged) });
    const number = files.pr.number;
    events.push(ev.human("pr.merged", check.role, cycle, number !== undefined ? { number, mergeSha: ctx.mergeSha } : { mergeSha: ctx.mergeSha }));
  }

  events.push(ev.system("stage.entered", cycle, { stage: gateDefs[gate].onAccept }));

  const plan: WritePlan = {
    changeId: view.id,
    files: writes,
    events: events.map((e) => ev.write(e)),
    commitMessage: `sdlc(${view.id}): accept ${doc.name} (gate ${gate})`,
    trailers: trailersFor(events, ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: check.role },
  };
  return { ok: true, plan };
}

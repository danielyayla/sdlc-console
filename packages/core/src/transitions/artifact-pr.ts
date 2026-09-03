import type { ArtifactIndex } from "../stages.js";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, SYSTEM_ACTOR, type TransitionContext } from "./context.js";

export interface ArtifactPrInfo {
  number: number;
  url: string;
  branch: string;
  headSha: string;
}

/** System record that an artifact draft is in review as a pull request (GitHub mode); committed on the artifact branch. */
export function recordArtifactPr(repo: Repo, view: ChangeView, artifact: ArtifactIndex, pr: ArtifactPrInfo, ctx: TransitionContext): TransitionResult {
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const existing = view.artifactPrs[artifact];
  if (existing && existing.number === pr.number && existing.headSha === pr.headSha) return refuse("artifact-pr.recorded", `PR #${pr.number} is already recorded for ${view.docs[artifact].name}`);
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.system("pr.opened", files.change.cycle, { number: pr.number, url: pr.url, headSha: pr.headSha, artifact, branch: pr.branch });
  const plan: WritePlan = {
    changeId: view.id,
    files: [],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): ${view.docs[artifact].name} in review as PR #${pr.number}`,
    trailers: { "SDLC-Event": event.id, "SDLC-Actor": `system:${SYSTEM_ACTOR.id}` },
    actor: { type: "system", id: SYSTEM_ACTOR.id },
  };
  return { ok: true, plan };
}

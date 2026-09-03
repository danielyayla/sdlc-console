import { commitWritePlan, git, headSha, mergeBranch, newUlid, type GitIdentity } from "@sdlc/adapter-git";
import { type ChangeView, type WritePlan } from "@sdlc/core";
import { stringifyYaml, type Event, type Pr } from "@sdlc/schemas";

export const SYSTEM_IDENTITY: GitIdentity = { id: "sdlc-bot@sdlc.local", name: "sdlc-bot" };

export interface OpenPrInput {
  root: string;
  view: ChangeView;
  branch: string;
  baseBranch: string;
  headSha: string;
  planMatches: boolean | null;
  nextSeq: number;
  now: string;
}

export interface OpenPrResult {
  pr: Pr;
  commit: string;
}

/** Code-host adapter (blueprint §7.6). Local mode records a branch merge; GitHub mode is Phase 2. */
export interface CodeHost {
  readonly provider: "local" | "github";
  openPr(input: OpenPrInput): Promise<OpenPrResult>;
  merge(root: string, pr: Pr, message: string, who: GitIdentity): Promise<string>;
}

function systemEvent<N extends Event["event"]>(name: N, cycle: number, seq: number, now: string, data: Extract<Event, { event: N }>["data"]): Event {
  return { schema: 1, id: newUlid(), ts: now, seq, cycle, actor: { type: "system", id: SYSTEM_IDENTITY.id }, event: name, data } as unknown as Event;
}

/** Local mode: the "PR" is `pr.yaml` on the default branch pointing at the task branch head. */
export class LocalCodeHost implements CodeHost {
  readonly provider = "local" as const;

  async openPr(input: OpenPrInput): Promise<OpenPrResult> {
    const pr: Pr = {
      schema: 1,
      provider: "local",
      branch: input.branch,
      baseBranch: input.baseBranch,
      headSha: input.headSha,
      openedAt: input.now,
      reviewers: [],
      checks: [{ name: "evidence", verdict: "pass" }],
      planMatches: input.planMatches,
    };
    const events = [systemEvent("pr.opened", input.view.cycle, input.nextSeq, input.now, { headSha: input.headSha }), systemEvent("stage.entered", input.view.cycle, input.nextSeq + 1, input.now, { stage: 5 })];
    const plan: WritePlan = {
      changeId: input.view.id,
      files: [{ path: `sdlc/changes/${input.view.id}/pr.yaml`, content: stringifyYaml(pr) }],
      events: events.map((event) => ({ changeId: input.view.id, event })),
      commitMessage: `sdlc(${input.view.id}): open PR ${input.branch} → ${input.baseBranch}`,
      trailers: { "SDLC-Event": events[0]?.id ?? "", "SDLC-Actor": `system:${SYSTEM_IDENTITY.id}` },
      actor: { type: "system", id: SYSTEM_IDENTITY.id },
    };
    const commit = await commitWritePlan(input.root, plan, { identity: SYSTEM_IDENTITY });
    return { pr, commit };
  }

  async merge(root: string, pr: Pr, message: string, who: GitIdentity): Promise<string> {
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== pr.baseBranch) throw new Error(`merge into ${pr.baseBranch} needs it checked out (currently ${current})`);
    await headSha(root, pr.branch);
    return mergeBranch(root, pr.branch, message, who);
  }
}

/** Phase 2: needs a GitHub App or token; refuses clearly instead of guessing. */
export class GitHubCodeHost implements CodeHost {
  readonly provider = "github" as const;

  openPr(): Promise<OpenPrResult> {
    return Promise.reject(new Error("GitHub mode needs a GITHUB_TOKEN or App credentials (Phase 2); set config.codeHost: local for now"));
  }

  merge(): Promise<string> {
    return Promise.reject(new Error("GitHub mode merges through the code host (Phase 2)"));
  }
}

export function codeHostFor(provider: "local" | "github"): CodeHost {
  return provider === "github" ? new GitHubCodeHost() : new LocalCodeHost();
}

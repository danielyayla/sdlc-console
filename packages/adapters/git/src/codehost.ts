import { type ChangeView, type WritePlan } from "@sdlc/core";
import { stringifyYaml, type Event, type Pr } from "@sdlc/schemas";
import { commitWritePlan, mergeBranch } from "./commit.js";
import { git, headSha, type GitIdentity } from "./git.js";
import { newUlid } from "./ids.js";

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
  /** Verdict of the run that opened the PR; published as the evidence check. */
  evidence?: "pass" | "fail";
  /** Literal output excerpt for the evidence check description. */
  evidenceSummary?: string;
}

export interface OpenPrResult {
  pr: Pr;
  commit: string;
}

/**
 * Code-host adapter (blueprint §7.6). Local mode records a branch merge;
 * GitHub mode (`@sdlc/adapter-github`) opens and merges real pull requests.
 * Both write the same `pr.yaml` mirror and ledger events; neither offers a
 * way around the gate-5 human.
 */
export interface CodeHost {
  readonly provider: "local" | "github";
  openPr(input: OpenPrInput): Promise<OpenPrResult>;
  /** Merge the PR as the acting human; returns the merge commit sha now on the local base branch. */
  merge(root: string, pr: Pr, message: string, who: GitIdentity): Promise<string>;
}

/** Error from the code host; `retryable` maps to HTTP 502 with retry in the console. */
export class CodeHostError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function systemEvent<N extends Event["event"]>(name: N, cycle: number, seq: number, now: string, data: Extract<Event, { event: N }>["data"]): Event {
  return { schema: 1, id: newUlid(), ts: now, seq, cycle, actor: { type: "system", id: SYSTEM_IDENTITY.id }, event: name, data } as unknown as Event;
}

/** Commit `pr.yaml` plus `pr.opened` and `stage.entered{5}` on the local default branch as sdlc-bot. */
export async function recordOpenedPr(input: OpenPrInput, pr: Pr): Promise<OpenPrResult> {
  const opened: Extract<Event, { event: "pr.opened" }>["data"] = { headSha: input.headSha, ...(pr.number !== undefined ? { number: pr.number } : {}), ...(pr.url !== undefined ? { url: pr.url } : {}) };
  const events = [systemEvent("pr.opened", input.view.cycle, input.nextSeq, input.now, opened), systemEvent("stage.entered", input.view.cycle, input.nextSeq + 1, input.now, { stage: 5 })];
  const plan: WritePlan = {
    changeId: input.view.id,
    files: [{ path: `sdlc/changes/${input.view.id}/pr.yaml`, content: stringifyYaml(pr) }],
    events: events.map((event) => ({ changeId: input.view.id, event })),
    commitMessage: `sdlc(${input.view.id}): open PR ${pr.number !== undefined ? `#${pr.number} ` : ""}${input.branch} → ${input.baseBranch}`,
    trailers: { "SDLC-Event": events[0]?.id ?? "", "SDLC-Actor": `system:${SYSTEM_IDENTITY.id}` },
    actor: { type: "system", id: SYSTEM_IDENTITY.id },
  };
  const commit = await commitWritePlan(input.root, plan, { identity: SYSTEM_IDENTITY });
  return { pr, commit };
}

/** Local mode: the "PR" is `pr.yaml` on the default branch pointing at the task branch head. */
export class LocalCodeHost implements CodeHost {
  readonly provider = "local" as const;

  openPr(input: OpenPrInput): Promise<OpenPrResult> {
    const pr: Pr = {
      schema: 1,
      provider: "local",
      branch: input.branch,
      baseBranch: input.baseBranch,
      headSha: input.headSha,
      openedAt: input.now,
      reviewers: [],
      checks: [{ name: "evidence", verdict: input.evidence ?? "pass" }],
      planMatches: input.planMatches,
    };
    return recordOpenedPr(input, pr);
  }

  async merge(root: string, pr: Pr, message: string, who: GitIdentity): Promise<string> {
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== pr.baseBranch) throw new CodeHostError(`merge into ${pr.baseBranch} needs it checked out (currently ${current})`, false);
    await headSha(root, pr.branch);
    try {
      return await mergeBranch(root, pr.branch, message, who);
    } catch (e) {
      throw new CodeHostError((e as Error).message, true);
    }
  }
}

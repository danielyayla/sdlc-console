import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodeHostError, branchExists, commitWritePlan, git, headSha, pushBranch } from "@sdlc/adapter-git";
import { GitHubError, assertProtected, findOpenPull, gitHubCodeHostFrom, openPull } from "@sdlc/adapter-github";
import { acceptProposal, checkAcceptProposal, type AcceptedPr, type WritePlan } from "@sdlc/core";
import type { ActionResult } from "./actions.js";
import { withBranchWorktree } from "./github/artifacts.js";
import { ActionError, type StateStore } from "./store.js";

const ROLE_RULES = /(not-owner|not-engineer|not-po)/;

/**
 * Accept a CLAUDE.md proposal (FR-43, spec 5A.2 "Accept opens a PR"): the
 * line is committed on `sdlc/proposals/<PRP>` under the accepting human, the
 * PR is opened for the code owners in GitHub mode (local mode records the
 * branch), and the proposal file on the default branch turns `accepted`.
 * The default branch's CLAUDE.md is never written here — the code owners'
 * merge under branch protection is what changes it.
 */
export async function acceptProposalAction(store: StateStore, id: string, env: Record<string, string | undefined> = process.env): Promise<ActionResult> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const pre = checkAcceptProposal(repo, id, store.context());
  if (!pre.ok) {
    const first = pre.result.ok ? undefined : pre.result.diagnostics[0];
    const status = first && ROLE_RULES.test(first.rule) ? 403 : first?.rule.endsWith(".missing") ? 404 : 409;
    throw new ActionError(status, first?.message ?? "refused", pre.result.ok ? [] : pre.result.diagnostics);
  }
  const { branch, content, path, proposal } = pre.check;
  const root = store.root;
  const base = repo.config.defaultBranch;
  if (!(await branchExists(root, branch))) await git(root, ["branch", branch, base]);
  const plan: WritePlan = {
    changeId: null,
    files: [{ path, content }],
    events: [],
    commitMessage: `sdlc(${id}): CLAUDE.md — ${proposal.text}`,
    trailers: { "SDLC-Actor": `human:${store.who.id}`, "SDLC-Proposal": id },
    actor: { type: "human", id: store.who.id },
  };
  const head = await withBranchWorktree(root, branch, async (dir) => {
    // a retried accept (the PR call failed last time) finds the line already committed
    let current: string | null;
    try {
      current = readFileSync(join(dir, path), "utf8");
    } catch {
      current = null;
    }
    if (current === content) return headSha(dir, "HEAD");
    return commitWritePlan(dir, plan, { identity: store.who });
  });
  let pr: AcceptedPr = { branch };
  if (repo.config.codeHost === "github") {
    const host = gitHubCodeHostFrom(env);
    if (!host) throw new ActionError(409, `${id}: config.codeHost is github but GITHUB_TOKEN is not set; the line is committed on ${branch} — push it and open the PR by hand, or set the token and accept again`);
    try {
      const repoGh = await host.repoFor(root);
      await assertProtected(host.client, repoGh, base);
      await pushBranch(root, branch);
      const pull = (await findOpenPull(host.client, repoGh, branch)) ?? (await openPull(host.client, repoGh, {
        head: branch,
        base,
        title: `sdlc(${id}): CLAUDE.md — ${proposal.text.length > 60 ? `${proposal.text.slice(0, 57)}…` : proposal.text}`,
        body: [`Proposed CLAUDE.md line (${id}), accepted by ${store.who.id}:`, "", `> ${proposal.text}`, "", `Repeat reason: ${proposal.reason ?? "—"}`, `Cited: ${proposal.citations.join(", ") || "—"}`, "", "The code owners of CLAUDE.md decide by merging; the console never merges configuration."].join("\n"),
      }));
      pr = { branch, number: pull.number, url: pull.url };
    } catch (e) {
      const retryable = e instanceof CodeHostError ? e.retryable : e instanceof GitHubError ? e.retryable : true;
      throw new ActionError(retryable ? 502 : 409, `${id}: the line is committed on ${branch} (${head.slice(0, 7)}) but the pull request was not opened: ${(e as Error).message}`, [], retryable);
    }
  }
  const r = await store.act((repo2, ctx) => acceptProposal(repo2, id, pr, ctx));
  const where = pr.number !== undefined ? `PR #${pr.number} opened for the code owners` : `branch ${branch} carries the line — open a PR from it for the code owners`;
  return { ...r, toast: `${id} accepted — ${where}`, changeId: null };
}

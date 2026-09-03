import { CodeHostError } from "@sdlc/adapter-git";
import type { GitHubClient } from "./client.js";
import type { GitHubRepo } from "./remote.js";

/** `protected` from the branch resource — readable without admin rights, unlike the protection resource itself. */
export async function branchProtected(client: GitHubClient, repo: GitHubRepo, branch: string): Promise<boolean> {
  const r = await client.get<{ protected?: boolean }>(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/branches/${encodeURIComponent(branch)}`);
  return r.data.protected === true;
}

/** GitHub mode only works under branch protection; an unprotected base means the gate could be walked around, so refuse. */
export async function assertProtected(client: GitHubClient, repo: GitHubRepo, branch: string): Promise<void> {
  if (!(await branchProtected(client, repo, branch))) {
    throw new CodeHostError(`${repo.owner}/${repo.repo} branch ${branch} is not protected; GitHub mode needs a pull request requirement on the base branch (refusing rather than merging around the gate)`, false);
  }
}

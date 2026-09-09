import { CodeHostError } from "@sdlc/adapter-git";
import type { GitLabClient } from "./client.js";
import type { ProjectRef } from "./remote.js";

/**
 * `protected` from the branch resource (`GET /projects/:id/repository/branches/:branch`),
 * readable by anyone with read access to the repository — unlike
 * `/protected_branches`, which needs Maintainer and 404s on an unprotected
 * name (indistinguishable from a missing branch under a reporter token).
 */
export async function branchProtected(client: GitLabClient, project: ProjectRef, branch: string): Promise<boolean> {
  const r = await client.get<{ protected?: boolean }>(`/projects/${project}/repository/branches/${encodeURIComponent(branch)}`);
  return r.data.protected === true;
}

/** GitLab mode only works under a protected target branch; an unprotected one means the gate could be walked around, so refuse — never a fallback. */
export async function assertProtected(client: GitLabClient, project: ProjectRef, branch: string): Promise<void> {
  if (!(await branchProtected(client, project, branch))) {
    throw new CodeHostError(`branch ${branch} of project ${decodeURIComponent(project)} is not protected; GitLab mode needs a protected target branch (merge through merge requests only) — refusing rather than merging around the gate`, false);
  }
}

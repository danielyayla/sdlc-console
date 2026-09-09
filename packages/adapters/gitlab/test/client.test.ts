import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeHostError, git } from "@sdlc/adapter-git";
import { GitLabClient, GitLabError, GitLabCodeHost, assertProtected, branchProtected, commitStatuses, credentialsFrom, findOpenMergeRequest, getMergeRequest, mergeMergeRequest, noteOnMergeRequest, openMergeRequest, parseGitLabRemote, parseProjectPath, projectRef, publishStatus, verdictState } from "../src/index.js";
import { startFakeGitLab, type FakeGitLab } from "./fake-gitlab.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function bareWithMain(): Promise<{ bare: string; work: string }> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-gl-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, "origin.git");
  await git(dir, ["init", "-q", "--bare", "-b", "main", bare]);
  const work = join(dir, "work");
  await git(dir, ["clone", "-q", bare, work]);
  await git(work, ["config", "user.email", "po@veri.example"]);
  await git(work, ["config", "user.name", "Priya"]);
  await git(work, ["config", "commit.gpgsign", "false"]);
  await git(work, ["commit", "-q", "--allow-empty", "-m", "root"]);
  await git(work, ["push", "-q", "origin", "main"]);
  return { bare, work };
}

async function fake(protectedBranch = true): Promise<{ gl: FakeGitLab; work: string }> {
  const { bare, work } = await bareWithMain();
  const gl = await startFakeGitLab({ bare, protected: protectedBranch });
  cleanups.push(() => gl.close());
  return { gl, work };
}

async function featureBranch(work: string, name: string, file = "f.txt"): Promise<string> {
  await git(work, ["checkout", "-q", "-b", name]);
  await git(work, ["commit", "-q", "--allow-empty", "-m", `commit on ${name} (${file})`]);
  await git(work, ["push", "-q", "origin", name]);
  const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
  await git(work, ["checkout", "-q", "main"]);
  return sha;
}

const P = projectRef("acme/widgets");

describe("project addressing and credentials (3.7)", () => {
  it("reads namespace/project from https, ssh and scp-style remotes, nested namespaces included", () => {
    expect(parseGitLabRemote("https://gitlab.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitLabRemote("https://gitlab.example.com/acme/platform/widgets")).toEqual({ owner: "acme/platform", repo: "widgets" });
    expect(parseGitLabRemote("git@gitlab.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitLabRemote("ssh://git@gitlab.example.com:2222/acme/platform/widgets.git")).toEqual({ owner: "acme/platform", repo: "widgets" });
    expect(parseGitLabRemote("/tmp/origin.git")).toBeNull();
    expect(parseProjectPath("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseProjectPath("widgets")).toBeNull();
    expect(projectRef("acme/platform/widgets")).toBe("acme%2Fplatform%2Fwidgets");
    expect(projectRef("42")).toBe("42");
  });

  it("takes GITLAB_TOKEN (else CI_JOB_TOKEN as a job token), CI_API_V4_URL, CI_PROJECT_ID or CI_PROJECT_PATH from the environment", () => {
    expect(credentialsFrom({})).toBeNull();
    expect(credentialsFrom({ GITLAB_TOKEN: "t" })).toEqual({ token: "t", tokenKind: "private", apiUrl: "https://gitlab.com/api/v4", project: null });
    expect(credentialsFrom({ CI_JOB_TOKEN: "j", CI_API_V4_URL: "http://127.0.0.1:1/api/v4", CI_PROJECT_PATH: "acme/widgets" })).toEqual({ token: "j", tokenKind: "job", apiUrl: "http://127.0.0.1:1/api/v4", project: "acme/widgets" });
    // a real token wins over the job token; the numeric id wins over the path
    expect(credentialsFrom({ GITLAB_TOKEN: "t", CI_JOB_TOKEN: "j", CI_PROJECT_ID: "42", CI_PROJECT_PATH: "acme/widgets" })).toMatchObject({ token: "t", tokenKind: "private", project: "42" });
  });
});

describe("REST client", () => {
  it("sends the token in the PRIVATE-TOKEN header (never a URL or Authorization) and maps non-2xx answers to GitLabError with retryability", async () => {
    const { gl } = await fake();
    const client = new GitLabClient({ token: gl.token, apiUrl: gl.url });
    expect(await branchProtected(client, P, "main")).toBe(true);
    expect(gl.state.requests[0]).toMatchObject({ method: "GET", path: "/projects/acme%2Fwidgets/repository/branches/main", privateToken: gl.token, jobToken: null });

    const bad = new GitLabClient({ token: "wrong", apiUrl: gl.url });
    const err = await getMergeRequest(bad, P, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect((err as GitLabError).status).toBe(401);
    expect((err as GitLabError).retryable).toBe(false);
    expect(new GitLabError("PUT", "/x", 405, "").retryable).toBe(true);
    expect(new GitLabError("PUT", "/x", 406, "").retryable).toBe(true);
    expect(new GitLabError("PUT", "/x", 409, "").retryable).toBe(true);
    expect(new GitLabError("GET", "/x", 502, "").retryable).toBe(true);
    expect(new GitLabError("POST", "/x", 400, "").retryable).toBe(false);
    // a job token reaches the API but is refused for merge requests, as GitLab refuses it
    const job = new GitLabClient({ token: gl.jobToken, tokenKind: "job", apiUrl: gl.url });
    expect(await branchProtected(job, P, "main")).toBe(true);
    expect(gl.state.requests.at(-1)).toMatchObject({ jobToken: gl.jobToken, privateToken: null });
    const forbidden = await findOpenMergeRequest(job, P, "main").catch((e: unknown) => e);
    expect((forbidden as GitLabError).status).toBe(403);
    expect((forbidden as GitLabError).retryable).toBe(false);
  });
});

describe("merge requests", () => {
  it("opens, finds and reads a merge request; merges through the API with the sha precondition (409 when the head moved, 405 while mergeability is computed, 405 once merged)", async () => {
    const { gl, work } = await fake();
    const client = new GitLabClient({ token: gl.token, apiUrl: gl.url });
    const head = await featureBranch(work, "CHG-0001/fix");
    const mr = await openMergeRequest(client, P, { sourceBranch: "CHG-0001/fix", targetBranch: "main", title: "sdlc(CHG-0001): fix", description: "body" });
    expect(mr).toMatchObject({ number: 1, url: "https://gitlab.example/acme/widgets/-/merge_requests/1", state: "open", merged: false, headSha: head, headRef: "CHG-0001/fix", baseRef: "main", mergeableState: "mergeable" });
    expect(gl.state.mergeRequests[0]).toMatchObject({ title: "sdlc(CHG-0001): fix", description: "body", source_branch: "CHG-0001/fix", target_branch: "main" });
    expect(await findOpenMergeRequest(client, P, "CHG-0001/fix")).toMatchObject({ number: 1 });
    expect(await findOpenMergeRequest(client, P, "nope")).toBeNull();
    expect(await getMergeRequest(client, P, 1)).toMatchObject({ number: 1, mergedBy: null });

    const moved = await mergeMergeRequest(client, P, 1, { sha: "b".repeat(40) }).catch((e: unknown) => e);
    expect((moved as GitLabError).status).toBe(409);
    expect((moved as GitLabError).retryable).toBe(true);
    expect((moved as GitLabError).message).toContain("SHA does not match");

    // mergeability still being computed: the adapter waits it out instead of failing
    gl.state.mergeabilityPending = 2;
    const merged = await mergeMergeRequest(client, P, 1, { sha: head, message: "merge it", wait: { attempts: 5, delayMs: 5 } });
    expect(merged.merged).toBe(true);
    expect(merged.sha).toHaveLength(40);
    expect((await git(gl.bare, ["rev-parse", "refs/heads/main"])).trim()).toBe(merged.sha);
    expect((await git(gl.bare, ["log", "-1", "--format=%s", "main"])).trim()).toBe("merge it");
    expect(await getMergeRequest(client, P, 1)).toMatchObject({ merged: true, state: "closed", mergeSha: merged.sha, mergedBy: "token-user" });
    const again = await mergeMergeRequest(client, P, 1, { sha: head, wait: { attempts: 1, delayMs: 1 } }).catch((e: unknown) => e);
    expect((again as GitLabError).status).toBe(405);
    expect((again as GitLabError).retryable).toBe(true);

    await noteOnMergeRequest(client, P, 1, "a note");
    expect(gl.state.notes).toEqual([{ iid: 1, body: "a note" }]);
  });
});

describe("commit statuses (the checks: GitLab has no check-runs API)", () => {
  it("publishes a status with name/state/description/target_url and reads the latest per name back", async () => {
    const { gl, work } = await fake();
    const client = new GitLabClient({ token: gl.token, apiUrl: gl.url });
    const head = await featureBranch(work, "s");
    await publishStatus(client, P, head, { name: "sdlc/evidence", state: verdictState("pass"), description: "45 passed", targetUrl: "https://gitlab.example/acme/widgets/-/merge_requests/1" });
    await publishStatus(client, P, head, { name: "sdlc/findings", state: verdictState("fail"), description: "1 high" });
    await publishStatus(client, P, head, { name: "sdlc/findings", state: verdictState("pending") });
    expect(gl.state.statuses.map((s) => s.body)).toEqual([
      { state: "success", name: "sdlc/evidence", description: "45 passed", target_url: "https://gitlab.example/acme/widgets/-/merge_requests/1" },
      { state: "failed", name: "sdlc/findings", description: "1 high" },
      { state: "pending", name: "sdlc/findings" },
    ]);
    const latest = await commitStatuses(client, P, head);
    expect(latest.map((s) => [s.name, s.state])).toEqual([["sdlc/evidence", "success"], ["sdlc/findings", "pending"]]);
  });
});

describe("protected target branch", () => {
  it("refuses, non-retryably, when the branch is not protected — never a fallback", async () => {
    const { gl } = await fake(false);
    const client = new GitLabClient({ token: gl.token, apiUrl: gl.url });
    expect(await branchProtected(client, P, "main")).toBe(false);
    const err = await assertProtected(client, P, "main").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeHostError);
    expect((err as CodeHostError).retryable).toBe(false);
    expect((err as CodeHostError).message).toContain("not protected");
  });
});

describe("GitLabCodeHost addressing", () => {
  it("resolves CI_PROJECT_ID through the API, CI_PROJECT_PATH as given, and the origin remote otherwise", async () => {
    const { gl, work } = await fake();
    const byId = new GitLabCodeHost({ credentials: { token: gl.token, tokenKind: "private", apiUrl: gl.url, project: String(gl.projectId) } });
    expect(await byId.repoFor(work)).toEqual({ owner: "acme", repo: "widgets" });
    expect(await byId.projectRef(work)).toBe("42");
    expect(gl.state.requests.filter((r) => r.path === "/projects/42")).toHaveLength(1);
    await byId.repoFor(work); // cached
    expect(gl.state.requests.filter((r) => r.path === "/projects/42")).toHaveLength(1);
    const byPath = new GitLabCodeHost({ credentials: { token: gl.token, tokenKind: "private", apiUrl: gl.url, project: "acme/platform/widgets" } });
    expect(await byPath.repoFor(work)).toEqual({ owner: "acme/platform", repo: "widgets" });
    expect(await byPath.projectRef(work)).toBe("acme%2Fplatform%2Fwidgets");
    // the origin remote here is a local path: no project can be parsed from it
    const byRemote = new GitLabCodeHost({ credentials: { token: gl.token, tokenKind: "private", apiUrl: gl.url, project: null } });
    const err = await byRemote.repoFor(work).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeHostError);
    expect((err as CodeHostError).message).toContain("CI_PROJECT_PATH");
    expect(byRemote.label(7)).toBe("MR !7");
    expect(byRemote.noreplyAddress("priya-gl")).toBe("priya-gl@users.noreply.gitlab.com");
    expect(byRemote.loginField).toBe("gitlab");
  });
});

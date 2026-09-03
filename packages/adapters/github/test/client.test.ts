import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "@sdlc/adapter-git";
import { GitHubClient, GitHubError, branchProtected, credentialsFrom, getPull, parseGitHubRemote, parseRepoSlug, publishStatus } from "../src/index.js";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function bareWithMain(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-gh-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, "origin.git");
  await git(dir, ["init", "-q", "--bare", "-b", "main", bare]);
  const work = join(dir, "work");
  await git(dir, ["clone", "-q", bare, work]);
  await git(work, ["config", "user.email", "po@veri.example"]);
  await git(work, ["config", "user.name", "Priya"]);
  await git(work, ["commit", "-q", "--allow-empty", "-m", "root"]);
  await git(work, ["push", "-q", "origin", "main"]);
  return bare;
}

async function fake(protectedBranch = true): Promise<FakeGitHub> {
  const gh = await startFakeGitHub({ bare: await bareWithMain(), protected: protectedBranch });
  cleanups.push(() => gh.close());
  return gh;
}

describe("remote parsing and credentials", () => {
  it("reads owner/repo from https, ssh and scp-style remotes", () => {
    expect(parseGitHubRemote("https://github.com/danielyayla/sdlc-console.git")).toEqual({ owner: "danielyayla", repo: "sdlc-console" });
    expect(parseGitHubRemote("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitHubRemote("ssh://git@ghe.example.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitHubRemote("/tmp/origin.git")).toBeNull();
    expect(parseRepoSlug("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseRepoSlug("widgets")).toBeNull();
  });

  it("takes GITHUB_TOKEN (or GH_TOKEN), GITHUB_API_URL and GITHUB_REPOSITORY from the environment", () => {
    expect(credentialsFrom({})).toBeNull();
    expect(credentialsFrom({ GH_TOKEN: "t" })).toEqual({ token: "t", apiUrl: "https://api.github.com", repository: null });
    expect(credentialsFrom({ GITHUB_TOKEN: "t", GITHUB_API_URL: "http://127.0.0.1:1/", GITHUB_REPOSITORY: "acme/widgets" })).toEqual({ token: "t", apiUrl: "http://127.0.0.1:1/", repository: { owner: "acme", repo: "widgets" } });
  });
});

describe("REST client", () => {
  it("sends the token as a bearer header and maps non-2xx answers to GitHubError with retryability", async () => {
    const gh = await fake();
    const client = new GitHubClient({ token: gh.token, apiUrl: gh.url });
    expect(await branchProtected(client, { owner: gh.owner, repo: gh.repo }, "main")).toBe(true);
    expect(gh.state.requests[0]).toMatchObject({ method: "GET", path: `/repos/${gh.owner}/${gh.repo}/branches/main`, auth: `Bearer ${gh.token}` });

    const bad = new GitHubClient({ token: "wrong", apiUrl: gh.url });
    const err = await getPull(bad, { owner: gh.owner, repo: gh.repo }, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
    expect((err as GitHubError).retryable).toBe(false);
    expect((err as GitHubError).message).toContain("Bad credentials");

    const missing = await getPull(client, { owner: gh.owner, repo: gh.repo }, 9).catch((e: unknown) => e as GitHubError);
    expect((missing as GitHubError).status).toBe(404);
    expect(new GitHubError("PUT", "/x", 409, "moved").retryable).toBe(true);
    expect(new GitHubError("PUT", "/x", 405, "blocked").retryable).toBe(true);
    expect(new GitHubError("PUT", "/x", 422, "invalid").retryable).toBe(false);
  });

  it("publishes a commit status with a trimmed description", async () => {
    const gh = await fake();
    const client = new GitHubClient({ token: gh.token, apiUrl: gh.url });
    const sha = (await git(gh.bare, ["rev-parse", "refs/heads/main"])).trim();
    await publishStatus(client, { owner: gh.owner, repo: gh.repo }, sha, { context: "sdlc/evidence", state: "success", description: "x".repeat(200), targetUrl: "https://example/pr/1" });
    expect(gh.state.statuses).toHaveLength(1);
    expect(gh.state.statuses[0]?.body).toMatchObject({ state: "success", context: "sdlc/evidence", target_url: "https://example/pr/1" });
    expect(String(gh.state.statuses[0]?.body["description"])).toHaveLength(138);
  });

  it("refuses to construct without a token", () => {
    expect(() => new GitHubClient({ token: "" })).toThrow(/needs a token/);
  });
});

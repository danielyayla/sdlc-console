import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "@sdlc/adapter-git";
import { GitHubClient, GitHubError, InstallationTokenSource, appCredentialsFrom, checkConclusion, clipEvidence, createCheckRun, credentialsFrom, gitHubCodeHostFrom, listCheckRuns, publishCheckRun, signAppJwt, updateCheckRun } from "../src/index.js";
import { startFakeGitHub, type FakeApp, type FakeGitHub } from "./fake-github.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** One RSA pair for the whole file: the App signs with the private key, the fake verifies with the public one. */
const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const APP: FakeApp = { id: 4242, slug: "sdlc-console", installationId: 77, publicKey: pair.publicKey };

async function bareWithMain(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-gh-app-"));
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

async function fake(app: FakeApp = APP): Promise<FakeGitHub> {
  const gh = await startFakeGitHub({ bare: await bareWithMain(), app });
  cleanups.push(() => gh.close());
  return gh;
}

const appEnv = (gh: FakeGitHub, extra: Record<string, string> = {}) => ({ SDLC_GITHUB_APP_ID: String(APP.id), SDLC_GITHUB_APP_INSTALLATION_ID: String(APP.installationId), SDLC_GITHUB_APP_PRIVATE_KEY: pair.privateKey, GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: `${gh.owner}/${gh.repo}`, ...extra });

describe("GitHub App credentials (3.2)", () => {
  it("token mode stays the default: no App variable → null App credentials, GITHUB_TOKEN alone is token mode", () => {
    expect(appCredentialsFrom({})).toBeNull();
    expect(credentialsFrom({ GITHUB_TOKEN: "t" })).toEqual({ token: "t", app: null, apiUrl: "https://api.github.com", repository: null });
  });

  it("reads the App id, installation id and PEM (inline or from a file); the App wins over a token when both are set; a partial set is an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-pem-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "app.pem");
    writeFileSync(file, pair.privateKey);
    const fromFile = credentialsFrom({ SDLC_GITHUB_APP_ID: "1", SDLC_GITHUB_APP_INSTALLATION_ID: "2", SDLC_GITHUB_APP_PRIVATE_KEY_FILE: file, GITHUB_TOKEN: "ignored" });
    expect(fromFile?.app).toEqual({ appId: "1", installationId: "2", privateKey: pair.privateKey });
    expect(fromFile?.token).toBeNull();
    const inline = appCredentialsFrom({ SDLC_GITHUB_APP_ID: "1", SDLC_GITHUB_APP_INSTALLATION_ID: "2", SDLC_GITHUB_APP_PRIVATE_KEY: "-----BEGIN\\nabc\\n-----END" });
    expect(inline?.privateKey).toBe("-----BEGIN\nabc\n-----END");
    expect(() => appCredentialsFrom({ SDLC_GITHUB_APP_ID: "1" })).toThrow(/all three, or none for token mode/);
  });

  it("signs an RS256 JWT the App endpoints accept and mints an installation token, cached until it is about to expire", async () => {
    const gh = await fake({ ...APP, tokenTtlMs: 5 * 60_000 });
    const jwt = signAppJwt(String(APP.id), pair.privateKey, new Date("2026-09-08T10:00:00Z"));
    const [, payload] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))).toEqual({ iss: "4242", iat: Date.parse("2026-09-08T09:59:00Z") / 1000, exp: Date.parse("2026-09-08T10:09:00Z") / 1000 });

    let clock = Date.now();
    const source = new InstallationTokenSource({ appId: String(APP.id), privateKey: pair.privateKey, installationId: String(APP.installationId) }, { apiUrl: gh.url, now: () => new Date(clock) });
    expect(await source.token()).toBe("ghs_1");
    expect(await source.token()).toBe("ghs_1"); // cached
    expect(source.mints).toBe(1);
    // within 60 s of expiry the next call mints a fresh one
    clock += 4 * 60_000 + 30_000;
    expect(await source.token()).toBe("ghs_2");
    expect(gh.state.jwtsAccepted).toBe(2);
    expect(gh.state.requests.filter((r) => r.path.endsWith("/access_tokens")).every((r) => r.auth?.startsWith("Bearer ey"))).toBe(true);

    // a JWT signed by another key is refused, so is a token issued for a different App id
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const bad = new InstallationTokenSource({ appId: String(APP.id), privateKey: other.privateKey, installationId: String(APP.installationId) }, { apiUrl: gh.url });
    const err = await bad.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
  });

  it("the App's bot user is the committer identity: <slug>[bot] with the noreply address GitHub links to the App", async () => {
    const gh = await fake();
    const host = gitHubCodeHostFrom(appEnv(gh));
    expect(host?.auth).toBe("app");
    expect(await host?.appIdentity()).toEqual({ name: "sdlc-console[bot]", id: "94242+sdlc-console[bot]@users.noreply.github.com" });
    // repo calls under the App carry the installation token, never the JWT or a PAT
    expect(await host?.repoFor("/nowhere")).toEqual({ owner: gh.owner, repo: gh.repo });
    const tokenHost = gitHubCodeHostFrom({ GITHUB_TOKEN: gh.token, GITHUB_API_URL: gh.url });
    expect(tokenHost?.auth).toBe("token");
    expect(await tokenHost?.appIdentity()).toBeNull();
  });
});

describe("check runs (App mode)", () => {
  it("creates a run with the evidence verbatim in output.text, updates it in place on the same head, and a PAT is refused", async () => {
    const gh = await fake();
    const client = new GitHubClient({ tokenSource: new InstallationTokenSource({ appId: String(APP.id), privateKey: pair.privateKey, installationId: String(APP.installationId) }, { apiUrl: gh.url }), apiUrl: gh.url });
    const repo = { owner: gh.owner, repo: gh.repo };
    const sha = (await git(gh.bare, ["rev-parse", "refs/heads/main"])).trim();
    const evidence = "--- test: pnpm test (exit 0)\nTests 45 passed (45)\n";
    const created = await createCheckRun(client, repo, { name: "sdlc/evidence", headSha: sha, ...checkConclusion("pass"), title: "run 1 green", summary: "1/1 commands passed", text: evidence, detailsUrl: "https://example/pr/1" });
    expect(created).toMatchObject({ id: 1, name: "sdlc/evidence", headSha: sha, status: "completed", conclusion: "success" });
    expect(gh.state.checkRuns[0]?.output).toEqual({ title: "run 1 green", summary: "1/1 commands passed", text: evidence });
    expect(gh.state.checkRuns[0]?.details_url).toBe("https://example/pr/1");

    const pending = await publishCheckRun(client, repo, { name: "sdlc/findings", headSha: sha, status: "in_progress", title: "review pending", summary: "…" });
    expect(pending.status).toBe("in_progress");
    const done = await publishCheckRun(client, repo, { name: "sdlc/findings", headSha: sha, status: "completed", conclusion: "failure", title: "1 high", summary: "tally", text: "- **high** SQL built by hand" });
    expect(done.id).toBe(pending.id); // updated, not a second run
    expect(gh.state.checkRuns.filter((r) => r.name === "sdlc/findings")).toHaveLength(1);
    expect(gh.state.checkRuns.find((r) => r.name === "sdlc/findings")).toMatchObject({ status: "completed", conclusion: "failure", output: { title: "1 high", text: "- **high** SQL built by hand" } });
    expect((await listCheckRuns(client, repo, sha)).map((r) => r.name)).toEqual(["sdlc/findings", "sdlc/evidence"]);
    expect(await updateCheckRun(client, repo, created.id, { status: "completed", conclusion: "neutral", title: "t", summary: "s" })).toMatchObject({ conclusion: "neutral" });

    const pat = new GitHubClient({ token: gh.token, apiUrl: gh.url });
    const refused = await createCheckRun(pat, repo, { name: "sdlc/evidence", headSha: sha, status: "completed", conclusion: "success", title: "t", summary: "s" }).catch((e: unknown) => e);
    expect((refused as GitHubError).status).toBe(403);
  });

  it("clips evidence at GitHub's limit with a pointer to the committed file, never a summary", () => {
    const long = "x".repeat(70_000);
    const clipped = clipEvidence(long, 65_535, "sdlc/changes/CHG-0001/evals/run-1.json");
    expect(clipped.length).toBe(65_535);
    expect(clipped.startsWith("x".repeat(1000))).toBe(true);
    expect(clipped).toMatch(/… \d+ more characters — the full output is in sdlc\/changes\/CHG-0001\/evals\/run-1\.json$/);
    expect(clipEvidence("short")).toBe("short");
    expect(checkConclusion("pending")).toEqual({ status: "in_progress" });
    expect(checkConclusion("fail")).toEqual({ status: "completed", conclusion: "failure" });
  });
});

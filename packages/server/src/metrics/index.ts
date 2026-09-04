import { combinedStatus, gitHubCodeHostFrom, listReviews, type Env, type GitHubCodeHost } from "@sdlc/adapter-github";
import { factsFromRepo, overlayGitHubFacts, type GitHubPrFacts, type GitHubStatusFacts, type MetricSources, type Repo } from "@sdlc/core";
import type { FactsCache } from "./cache.js";

export { FactsCache } from "./cache.js";

export interface SourceStatus {
  /** Where the feed's facts come from: the GitHub cache, the git mirror, or nowhere. */
  via: "github" | "git" | "none";
  /** When the GitHub facts were last fetched (null for a mirror-only feed). */
  fetchedAt: string | null;
  facts: number;
}

export interface MetricSourcesStatus {
  pr: SourceStatus;
  ci: SourceStatus;
  incidents: SourceStatus;
}

export interface CollectedSources {
  sources: MetricSources;
  status: MetricSourcesStatus;
}

/** The feeds the metrics read now: the git mirror, overlaid with whatever GitHub facts the cache holds. */
export function collectSources(repo: Repo, cache: FactsCache | null): CollectedSources {
  const base = factsFromRepo(repo);
  const prs = cache?.prs() ?? [];
  const statuses = cache?.statuses() ?? [];
  const sources = prs.length || statuses.length ? overlayGitHubFacts(base, prs, statuses) : base;
  const fetchedAt = cache?.fetchedAt() ?? null;
  const status = (feed: "pr" | "ci" | "incidents", github: boolean): SourceStatus => {
    const facts = sources[feed]?.length ?? 0;
    return { via: sources[feed] === null ? "none" : github ? "github" : "git", fetchedAt: github ? fetchedAt : null, facts };
  };
  return { sources, status: { pr: status("pr", prs.length > 0), ci: status("ci", statuses.length > 0), incidents: status("incidents", false) } };
}

export interface RefreshSummary {
  /** PR heads whose reviews were fetched this pass. */
  prs: number;
  /** Heads whose combined status was fetched this pass. */
  statuses: number;
  /** Merged heads already in the cache — final, never refetched. */
  cached: number;
  errors: string[];
}

const HUMAN_DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Fetch GitHub facts for every recorded GitHub PR: reviews (the first human
 * decision — APPROVED or CHANGES_REQUESTED; COMMENTED reviews are what the
 * review job posts and are left to the mirror) and the combined status of the
 * head. A merged head is final, so its rows are fetched once; open heads are
 * refreshed on every pass.
 */
export async function refreshFacts(host: GitHubCodeHost, root: string, repo: Repo, cache: FactsCache, now: () => Date = () => new Date()): Promise<RefreshSummary> {
  const summary: RefreshSummary = { prs: 0, statuses: 0, cached: 0, errors: [] };
  const gh = await host.repoFor(root);
  const stamp = now().toISOString();
  for (const files of repo.changes.values()) {
    const pr = files.pr;
    if (!pr || pr.provider !== "github" || pr.number === undefined) continue;
    const merged = pr.mergedAt !== undefined;
    if (merged && cache.pr(pr.number, pr.headSha) && cache.status(pr.headSha)) {
      summary.cached++;
      continue;
    }
    try {
      const reviews = await listReviews(host.client, gh, pr.number);
      const human = reviews.filter((r) => HUMAN_DECISIONS.has(r.state) && r.submittedAt !== null);
      const fact: GitHubPrFacts = { number: pr.number, headSha: pr.headSha, firstReviewAt: human[0]?.submittedAt ?? null, reviews: reviews.length, fetchedAt: stamp };
      cache.putPr(fact);
      summary.prs++;
      const combined = await combinedStatus(host.client, gh, pr.headSha);
      const status: GitHubStatusFacts = { headSha: pr.headSha, statuses: combined.statuses.map((s) => ({ context: s.context, state: s.state, createdAt: s.createdAt, updatedAt: s.updatedAt })), fetchedAt: stamp };
      cache.putStatus(status);
      summary.statuses++;
    } catch (e) {
      summary.errors.push(`${files.id} #${pr.number}: ${(e as Error).message}`);
    }
  }
  return summary;
}

/** `sdlc metrics --refresh`: fetch when the repo is in GitHub mode and a token is present; null otherwise (the caller says why). */
export async function refreshFactsFromEnv(root: string, repo: Repo, cache: FactsCache, env: Env, now?: () => Date): Promise<RefreshSummary | null> {
  if (repo.config.codeHost !== "github") return null;
  const host = gitHubCodeHostFrom(env);
  if (!host) return null;
  return refreshFacts(host, root, repo, cache, now);
}

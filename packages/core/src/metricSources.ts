import type { Event } from "@sdlc/schemas";
import { eventsNamed } from "./events.js";
import type { ChangeFiles, Repo } from "./repo.js";

/**
 * External facts the metrics read (FR-70, blueprint 7.11): PR metadata, CI
 * verdicts and incident records. Core never fetches them — `factsFromRepo`
 * derives what the git mirror holds (`pr.yaml`, runs, suite runs,
 * `incident.md`, triage) and the server overlays what its adapters cached
 * (GitHub reviews and commit statuses). A feed is `null` when nothing feeds
 * it, so a metric can say "n/a · needs <source>" instead of showing zero.
 */

export interface PrFact {
  changeId: string;
  cycle: number;
  provider: "local" | "github";
  number: number | null;
  /** Head the PR opened with (the first head CI judged), then the current one. */
  openedHeadSha: string;
  headSha: string;
  openedAt: string;
  mergedAt: string | null;
  /** Earliest review: the review job in local mode, the first human review when GitHub facts are cached. */
  firstReviewAt: string | null;
  reviewedBy: "human" | "review-job" | null;
  reviews: number;
  /** The code was produced by an agent session in this cycle. */
  agentAuthored: boolean;
}

export interface CiFact {
  changeId: string;
  headSha: string;
  name: string;
  verdict: "pass" | "fail" | "pending";
  origin: "run" | "status" | "suite";
  startedAt: string;
  finishedAt: string | null;
}

export interface IncidentFact {
  id: string;
  changeId: string | null;
  createdAt: string;
  /** When the fix for it merged (a later-cycle merge on the change, or the triage item's accepted change merging). */
  fixedAt: string | null;
  src: string;
  tier: string;
  origin: "incident.md" | "triage";
}

export interface MetricSources {
  pr: PrFact[] | null;
  ci: CiFact[] | null;
  incidents: IncidentFact[] | null;
}

export const EMPTY_SOURCES: MetricSources = { pr: null, ci: null, incidents: null };

/** Human-readable name of a feed, for "n/a · needs <source>". */
export const SOURCE_NAMES = { pr: "PR metadata", ci: "CI", incidents: "incident records" } as const;

function firstMergeAfter(events: readonly Event[], ts: string, cycle: number): string | null {
  const t = Date.parse(ts);
  for (const e of eventsNamed(events, "pr.merged")) {
    if (e.cycle > cycle && Date.parse(e.ts) >= t) return e.ts;
  }
  return null;
}

function prFactsOf(files: ChangeFiles): PrFact[] {
  const pr = files.pr;
  if (!pr) return [];
  const cycle = files.change?.cycle ?? 1;
  const opened = eventsNamed(files.events, "pr.opened").filter((e) => e.data.artifact === undefined).at(-1) ?? null;
  const openedAt = opened?.ts ?? pr.openedAt;
  const agentAuthored = files.events.some((e) => e.cycle === cycle && e.actor.type === "agent" && Date.parse(e.ts) <= Date.parse(openedAt));
  return [
    {
      changeId: files.id,
      cycle,
      provider: pr.provider,
      number: pr.number ?? null,
      openedHeadSha: opened?.data.headSha ?? pr.headSha,
      headSha: pr.headSha,
      openedAt: pr.openedAt,
      mergedAt: pr.mergedAt ?? null,
      firstReviewAt: pr.review?.at ?? null,
      reviewedBy: pr.review ? "review-job" : null,
      reviews: pr.review ? 1 : 0,
      agentAuthored,
    },
  ];
}

function headAt(files: ChangeFiles, headSha: string): string {
  const sync = [...eventsNamed(files.events, "pr.synchronized")].reverse().find((e) => e.data.headSha === headSha);
  if (sync) return sync.ts;
  const opened = [...eventsNamed(files.events, "pr.opened")].reverse().find((e) => e.data.headSha === headSha);
  return opened?.ts ?? files.pr?.openedAt ?? "";
}

function ciFactsOf(repo: Repo, files: ChangeFiles): CiFact[] {
  const facts: CiFact[] = [];
  for (const r of files.runs) {
    facts.push({ changeId: files.id, headSha: r.headSha, name: `run-${r.n}`, verdict: r.verdict === "green" ? "pass" : "fail", origin: "run", startedAt: r.startedAt, finishedAt: r.finishedAt ?? null });
  }
  if (files.pr) {
    const at = headAt(files, files.pr.headSha);
    for (const c of files.pr.checks) {
      if (at !== "") facts.push({ changeId: files.id, headSha: files.pr.headSha, name: c.name, verdict: c.verdict, origin: "status", startedAt: at, finishedAt: null });
    }
  }
  void repo;
  return facts;
}

function suiteFacts(repo: Repo): CiFact[] {
  return repo.evalRuns
    .filter((r) => r.trigger === "config-pr")
    .map((r) => ({ changeId: "", headSha: r.configRef.claudeMdSha, name: r.id, verdict: r.verdict === "pass" ? "pass" : r.verdict === "fail" ? "fail" : "pending", origin: "suite" as const, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null }));
}

function incidentFactsOf(repo: Repo): IncidentFact[] {
  const facts: IncidentFact[] = [];
  for (const files of repo.changes.values()) {
    const inc = files.incident;
    if (!inc) continue;
    const fm = inc.frontMatter;
    facts.push({ id: `${files.id}/incident.md`, changeId: files.id, createdAt: fm.created, fixedAt: firstMergeAfter(files.events, fm.created, fm.cycle), src: fm.src, tier: fm.tier, origin: "incident.md" });
  }
  for (const t of repo.triage) {
    if (t.data.tier !== "incident") continue;
    const accepted = t.data.acceptedAs ? repo.changes.get(t.data.acceptedAs) : undefined;
    const fixedAt = accepted ? (eventsNamed(accepted.events, "pr.merged")[0]?.ts ?? null) : null;
    facts.push({ id: t.data.id, changeId: t.data.acceptedAs ?? null, createdAt: t.data.createdAt, fixedAt, src: t.data.src, tier: t.data.tier, origin: "triage" });
  }
  return facts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** What the git mirror holds for each feed; a feed with nothing in it is null. */
export function factsFromRepo(repo: Repo): MetricSources {
  const pr: PrFact[] = [];
  const ci: CiFact[] = [];
  for (const files of repo.changes.values()) {
    pr.push(...prFactsOf(files));
    ci.push(...ciFactsOf(repo, files));
  }
  ci.push(...suiteFacts(repo));
  ci.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const incidents = incidentFactsOf(repo);
  return { pr: pr.length ? pr : null, ci: ci.length ? ci : null, incidents: incidents.length ? incidents : null };
}

/** GitHub facts the server cached for one PR head (reviews) and one commit (statuses). */
export interface GitHubPrFacts {
  number: number;
  headSha: string;
  /** Earliest human review (`submitted_at`) and how many reviews there are. */
  firstReviewAt: string | null;
  reviews: number;
  fetchedAt: string;
}

export interface GitHubStatusFacts {
  headSha: string;
  statuses: { context: string; state: "success" | "failure" | "pending" | "error"; createdAt: string; updatedAt: string }[];
  fetchedAt: string;
}

/** Overlay cached GitHub facts on the mirror: a human review beats the review job; statuses add timing and CI checks the mirror never saw. */
export function overlayGitHubFacts(base: MetricSources, prs: readonly GitHubPrFacts[], statuses: readonly GitHubStatusFacts[]): MetricSources {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const pr = (base.pr ?? []).map((f) => {
    const gh = f.provider === "github" && f.number !== null ? byNumber.get(f.number) : undefined;
    if (!gh) return f;
    return { ...f, firstReviewAt: gh.firstReviewAt ?? f.firstReviewAt, reviewedBy: gh.firstReviewAt ? ("human" as const) : f.reviewedBy, reviews: gh.reviews };
  });
  const ci = [...(base.ci ?? [])];
  const changeOf = new Map(pr.map((f) => [f.headSha, f.changeId]));
  for (const s of statuses) {
    for (const st of s.statuses) {
      const verdict = st.state === "success" ? "pass" : st.state === "pending" ? "pending" : "fail";
      const i = ci.findIndex((c) => c.headSha === s.headSha && c.name === st.context.replace(/^sdlc\//, "") && c.origin === "status");
      const fact: CiFact = { changeId: changeOf.get(s.headSha) ?? "", headSha: s.headSha, name: st.context, verdict, origin: "status", startedAt: st.createdAt, finishedAt: st.updatedAt };
      if (i >= 0) ci[i] = fact;
      else ci.push(fact);
    }
  }
  ci.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { pr: pr.length || prs.length ? pr : base.pr, ci: ci.length || statuses.length ? ci : base.ci, incidents: base.incidents };
}

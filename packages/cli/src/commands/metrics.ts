import { computeMetrics, deriveAll, parseWindow, type MetricValue, type StageMetrics } from "@sdlc/core";
import { collectSources, FactsCache, refreshFactsFromEnv, SessionRegistry, type MetricSourcesStatus, type RefreshSummary } from "@sdlc/server";
import { loadCommitted, type CliContext } from "../context.js";
import { CliError } from "../io.js";

export interface MetricsReport {
  window: string;
  generatedAt: string;
  sources: MetricSourcesStatus;
  refreshed: RefreshSummary | null;
  metrics: StageMetrics[];
}

export interface MetricsArgs {
  stage?: string | undefined;
  window?: string | undefined;
  refresh?: boolean | undefined;
  now?: () => Date;
}

/** `sdlc metrics [--stage n] [--window 30d] [--refresh]`: the per-stage table over git, the ledger and the cached feeds; read-only. */
export async function metricsReport(ctx: CliContext, args: MetricsArgs): Promise<MetricsReport> {
  const days = parseWindow(args.window);
  if (days === null) throw new CliError(`--window must be like 7d, 30d or 90d (got ${args.window ?? ""})`, 2);
  const stage = args.stage === undefined ? null : Number(args.stage);
  if (stage !== null && !(Number.isInteger(stage) && stage >= 1 && stage <= 6)) throw new CliError(`--stage must be 1–6 (got ${args.stage ?? ""})`, 2);
  const { repo } = await loadCommitted(ctx);
  const registry = new SessionRegistry(ctx.root);
  try {
    const cache = new FactsCache(registry.database);
    let refreshed: RefreshSummary | null = null;
    if (args.refresh) {
      refreshed = await refreshFactsFromEnv(ctx.root, repo, cache, ctx.io.env, args.now);
      if (!refreshed) throw new CliError("--refresh needs config.codeHost github and GITHUB_TOKEN in the environment; without them the metrics read the git mirror", 2);
    }
    const collected = collectSources(repo, cache);
    const now = (args.now?.() ?? new Date()).toISOString();
    const all = computeMetrics(repo, deriveAll(repo).changes, { now, windowDays: days, sources: collected.sources });
    return { window: `${days}d`, generatedAt: now, sources: collected.status, refreshed, metrics: stage === null ? all : all.filter((s) => s.stage === stage) };
  } finally {
    registry.close();
  }
}

function fmt(v: MetricValue): string {
  if (v.value === null) return "n/a";
  if (v.unit === "pct") return `${v.value}%`;
  if (v.unit === "hours") return v.value >= 48 ? `${Math.round(v.value / 24)}d` : `${v.value}h`;
  return String(v.value);
}

function chip(v: MetricValue): string {
  if (v.trend === null) return "  —  ";
  if (v.trend === "flat") return "  —  ";
  const arrow = v.trend === "up" ? "▲" : "▼";
  const good = v.trend === v.better ? "" : "!";
  return `${arrow}${v.delta === null ? "" : `${v.delta > 0 ? "+" : ""}${v.delta}%`}${good}`.padEnd(5);
}

export function renderMetrics(r: MetricsReport): string {
  const via = (s: MetricSourcesStatus[keyof MetricSourcesStatus]) => (s.via === "none" ? "none" : s.via === "github" ? `GitHub${s.fetchedAt ? ` · fetched ${s.fetchedAt}` : ""}` : "git mirror");
  const lines = [`window ${r.window} · PR metadata: ${via(r.sources.pr)} · CI: ${via(r.sources.ci)} · incident records: ${via(r.sources.incidents)}`];
  if (r.refreshed) lines.push(`refreshed: ${r.refreshed.prs} PR(s), ${r.refreshed.statuses} status(es), ${r.refreshed.cached} cached${r.refreshed.errors.length ? ` · ${r.refreshed.errors.join("; ")}` : ""}`);
  for (const s of r.metrics) {
    lines.push(`${String(s.stage).padStart(2, "0")} ${s.name}`);
    for (const [label, values] of [["leading", s.leading], ["lagging", s.lagging]] as const) {
      for (const v of values) lines.push(`  ${label.padEnd(7)} ${v.name.padEnd(34)} ${fmt(v).padStart(6)}  ${chip(v)}  ${v.note}  [${v.sources.join(" · ") || "—"}]`);
    }
  }
  return lines.join("\n");
}

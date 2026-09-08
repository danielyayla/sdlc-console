import { parseFrontMatter, type ChangeExport, type ExportArtifact, type ExportCycle, type ExportDecision, type ExportFinding, type Event } from "@sdlc/schemas";
import type { ChangeView } from "./derive.js";
import { eventsNamed, eventsOfCycle } from "./events.js";
import type { ChangeFiles, Repo } from "./repo.js";
import { sha256Hex } from "./sha256.js";
import { filesUnder, readFile } from "./tree.js";

export interface ExportHeader {
  exportedAt: string;
  exportedBy: { id: string; name?: string };
  /** Commit sha per ledger event id (the commit carrying its `SDLC-Event` trailer), resolved by the git adapter; absent from a synthetic tree. */
  commits?: Readonly<Record<string, string>>;
}

/**
 * Canonical JSON: keys sorted at every level, no whitespace, `undefined`
 * members dropped — the same bytes for the same document wherever it is
 * serialized, so the content hash is verifiable by anyone.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 over the canonical JSON of the document without its `contentHash`. */
export function exportContentHash(doc: Omit<ChangeExport, "contentHash"> | ChangeExport): string {
  const { contentHash: _hash, ...rest } = doc as ChangeExport;
  void _hash;
  return sha256Hex(canonicalJson(rest));
}

/** True when the document's `contentHash` matches its content (an auditor's integrity check). */
export function verifyChangeExport(doc: ChangeExport): boolean {
  return doc.contentHash.algorithm === "sha256" && doc.contentHash.over === "canonical-json" && doc.contentHash.value === exportContentHash(doc);
}

const ARTIFACT_FILES = ["intent.md", "spec.md", "plan.md", null, "pr.yaml", "incident.md"] as const;

function artifactsIn(repo: Repo, dir: string): ExportArtifact[] {
  const out: ExportArtifact[] = [];
  ARTIFACT_FILES.forEach((name, index) => {
    if (name === null) return;
    const path = `${dir}/${name}`;
    const file = readFile(repo.tree, path);
    if (!file) return;
    // the front-matter as written (not re-validated): an auditor reads the file, the content hash covers it verbatim
    const frontMatter = name.endsWith(".md") ? ((parseFrontMatter(file.content, path).value?.data as Record<string, unknown> | undefined) ?? null) : null;
    out.push({ index, name, path, sha: file.sha, frontMatter, content: file.content });
  });
  // evals: the run records are exported as parsed runs; other files under evals/ (final round, repro proof) travel verbatim
  for (const path of filesUnder(repo.tree, `${dir}/evals`)) {
    const name = path.slice(dir.length + 1);
    if (/^evals\/run-\d+\.json$/.test(name)) continue;
    const file = readFile(repo.tree, path);
    if (file) out.push({ index: 3, name, path, sha: file.sha, frontMatter: null, content: file.content });
  }
  return out;
}

function decisionsOf(events: readonly Event[], commits: Readonly<Record<string, string>>): ExportDecision[] {
  const out: ExportDecision[] = [];
  for (const e of events) {
    if (e.event !== "gate.accepted" && e.event !== "gate.sent_back") continue;
    const accepted = e.event === "gate.accepted";
    out.push({
      eventId: e.id,
      cycle: e.cycle,
      seq: e.seq,
      ts: e.ts,
      gate: e.data.gate,
      decision: accepted ? "accepted" : "sent_back",
      by: { id: e.actor.id, role: e.actor.role ?? null },
      source: accepted ? e.data.source : null,
      artifactSha: accepted ? e.data.artifactSha : null,
      note: accepted ? (e.data.note ?? null) : e.data.feedback,
      commit: commits[e.id] ?? null,
    });
  }
  return out;
}

function findingsOf(events: readonly Event[]): ExportFinding[] {
  return eventsNamed(events, "review.finding").map((e) => ({ eventId: e.id, cycle: e.cycle, ts: e.ts, severity: e.data.severity, title: e.data.title, path: e.data.path ?? null, detail: e.data.detail ?? null, session: e.actor.session ?? null }));
}

function cycleOf(repo: Repo, files: ChangeFiles, cycle: number, archived: boolean, commits: Readonly<Record<string, string>>): ExportCycle {
  const dir = archived ? `${files.dir}/cycles/${cycle}` : files.dir;
  const events = eventsOfCycle(files.events, cycle);
  const archive = files.archived.find((a) => a.cycle === cycle) ?? null;
  return {
    cycle,
    archived,
    dir,
    artifacts: artifactsIn(repo, dir),
    decisions: decisionsOf(events, commits),
    pr: archived ? (archive?.pr ?? null) : files.pr,
    artifactPrs: eventsNamed(events, "pr.opened")
      .filter((e) => e.data.artifact !== undefined)
      .map((e) => ({ artifact: e.data.artifact as number, number: e.data.number ?? null, url: e.data.url ?? null, branch: e.data.branch ?? null, headSha: e.data.headSha })),
    merges: eventsNamed(events, "pr.merged").map((e) => ({ eventId: e.id, ts: e.ts, number: e.data.number ?? null, mergeSha: e.data.mergeSha })),
    runs: archived ? (archive?.runs ?? []) : files.runs.filter((r) => r.cycle === cycle),
    findings: findingsOf(events),
    deploy: archived ? (archive?.deploy ?? null) : files.deploy,
  };
}

/**
 * Compliance export of one change: its record, every cycle (live and
 * archived) with artifacts, gate decisions, pull requests, per-change runs,
 * findings and deploy record, the ledger verbatim in order, and a content
 * hash. Pure over the tree; the server and the CLI only serialize it.
 * Returns null when the change directory does not exist.
 */
export function exportChange(repo: Repo, view: ChangeView, header: ExportHeader): ChangeExport | null {
  const files = repo.changes.get(view.id);
  if (!files) return null;
  const commits = header.commits ?? {};
  const cycles = new Set<number>(files.archivedCycles);
  for (const e of files.events) cycles.add(e.cycle);
  cycles.add(files.change?.cycle ?? view.cycle);
  const live = files.change?.cycle ?? view.cycle;
  const ordered = [...cycles].sort((a, b) => a - b);
  const body: Omit<ChangeExport, "contentHash"> = {
    schema: 1,
    kind: "change-export",
    exportedAt: header.exportedAt,
    exportedBy: { id: header.exportedBy.id, ...(header.exportedBy.name !== undefined ? { name: header.exportedBy.name } : {}) },
    ref: repo.tree.ref,
    change: files.change,
    derived: {
      stage: view.stage,
      stageName: view.stageName,
      status: view.status,
      acceptedGates: view.acceptedGates,
      valid: view.valid,
      validationErrors: view.validationErrors.map((d) => ({ path: d.path, ...(d.pointer !== undefined ? { pointer: d.pointer } : {}), ...(d.line !== undefined ? { line: d.line } : {}), severity: d.severity, message: d.message, rule: d.rule })),
    },
    cycles: ordered.map((n) => cycleOf(repo, files, n, n !== live && files.archivedCycles.includes(n), commits)),
    events: files.events,
    evalCases: repo.evalCases.filter((c) => c.source.ref === view.id || c.id === `INC-${view.id}-${live - 1}`).map((c) => ({ id: c.id, status: c.status, source: c.source })),
  };
  return { ...body, contentHash: { algorithm: "sha256", over: "canonical-json", value: exportContentHash(body) } };
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** The export as Markdown for people; the JSON stays the canonical, hashed form. */
export function renderChangeExportMarkdown(doc: ChangeExport): string {
  const c = doc.change;
  const lines: string[] = [];
  lines.push(`# Compliance export · ${c?.id ?? "unknown change"}${c ? ` · ${c.title}` : ""}`, "");
  lines.push(`- exported at: ${doc.exportedAt}`, `- exported by: ${doc.exportedBy.id}${doc.exportedBy.name ? ` (${doc.exportedBy.name})` : ""}`, `- tree: ${doc.ref ?? "synthetic"}`, `- content hash (sha256 over canonical JSON): \`${doc.contentHash.value}\``, "");
  lines.push("## Change", "");
  if (c) {
    lines.push(`- kind: ${c.kind} · risk: ${c.risk} · cycle: ${c.cycle}`, `- created: ${c.created.at} by ${c.created.by}`, `- origin: ${c.origin.type}${c.origin.ref ? ` (${c.origin.ref})` : ""}`, `- record: ${c.record ? `${c.record.system} ${c.record.id}${c.record.url ? ` <${c.record.url}>` : ""}` : "none"}`, `- closed: ${c.closed ? `${c.closed.at} — ${c.closed.reason}` : "no"}`);
  } else {
    lines.push("- change.yaml unreadable");
  }
  lines.push(`- derived stage: ${doc.derived.stage} · ${doc.derived.stageName} · ${doc.derived.status}`, `- accepted gates: ${doc.derived.acceptedGates.join(", ") || "none"}`, `- valid: ${doc.derived.valid ? "yes" : `no (${doc.derived.validationErrors.map((d) => `${d.rule}: ${d.message}`).join("; ")})`}`, "");
  for (const cy of doc.cycles) {
    lines.push(`## Cycle ${cy.cycle}${cy.archived ? " (archived)" : " (live)"} · \`${cy.dir}\``, "");
    lines.push("### Artifacts", "", "| # | file | blob sha |", "|---|------|----------|");
    for (const a of cy.artifacts) lines.push(`| ${a.index} | ${a.name} | ${a.sha} |`);
    if (cy.artifacts.length === 0) lines.push("| — | none | — |");
    lines.push("", "### Gate decisions", "", "| when | gate | decision | who | role | source | artifact sha | commit | note |", "|------|------|----------|-----|------|--------|--------------|--------|------|");
    for (const d of cy.decisions) lines.push(`| ${d.ts} | ${d.gate} | ${d.decision} | ${d.by.id} | ${d.by.role ?? "—"} | ${d.source ?? "—"} | ${short(d.artifactSha)} | ${short(d.commit)} | ${(d.note ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
    if (cy.decisions.length === 0) lines.push("| — | — | none | — | — | — | — | — | — |");
    lines.push("");
    if (cy.pr) {
      lines.push("### Pull request", "", `- ${cy.pr.provider}${cy.pr.number ? ` #${cy.pr.number}` : ""}${cy.pr.url ? ` <${cy.pr.url}>` : ""} · ${cy.pr.branch} → ${cy.pr.baseBranch}`, `- head ${cy.pr.headSha}${cy.pr.mergeSha ? ` · merged ${cy.pr.mergeSha} at ${cy.pr.mergedAt ?? "?"}` : " · not merged"}`, `- checks: ${cy.pr.checks.map((k) => `${k.name} ${k.verdict}${k.summary ? ` (${k.summary})` : ""}`).join("; ") || "none"}`, `- reviewers: ${cy.pr.reviewers.join(", ") || "none"}${cy.pr.review ? ` · review session ${cy.pr.review.session} of ${short(cy.pr.review.headSha)} at ${cy.pr.review.at}` : ""}`, "");
    }
    for (const p of cy.artifactPrs) lines.push(`- artifact PR${p.number ? ` #${p.number}` : ""} for artifact ${p.artifact}${p.url ? ` <${p.url}>` : ""} · head ${short(p.headSha)}`);
    for (const m of cy.merges) lines.push(`- merge ${m.mergeSha}${m.number ? ` (PR #${m.number})` : ""} at ${m.ts}`);
    if (cy.artifactPrs.length > 0 || cy.merges.length > 0) lines.push("");
    lines.push("### Per-change runs", "", "| run | verdict | head | commands | eval cases | started |", "|-----|---------|------|----------|------------|---------|");
    for (const r of cy.runs) lines.push(`| ${r.n} | ${r.verdict} | ${short(r.headSha)} | ${r.commandResults.filter((x) => x.pass).length}/${r.commandResults.length} | ${r.results.filter((x) => x.pass).length}/${r.results.length} | ${r.startedAt} |`);
    if (cy.runs.length === 0) lines.push("| — | none | — | — | — | — |");
    lines.push("");
    if (cy.findings.length > 0) {
      lines.push("### Review findings", "");
      for (const f of cy.findings) lines.push(`- [${f.severity}] ${f.title}${f.path ? ` (${f.path})` : ""}${f.session ? ` · session ${f.session}` : ""} · ${f.ts}${f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""}`);
      lines.push("");
    }
    if (cy.deploy) lines.push("### Deploy record", "", "```yaml", JSON.stringify(cy.deploy, null, 2), "```", "");
  }
  if (doc.evalCases.length > 0) {
    lines.push("## Eval cases from this change", "");
    for (const e of doc.evalCases) lines.push(`- ${e.id} · ${e.status} · ${e.source.type}${e.source.ref ? ` ${e.source.ref}` : ""}`);
    lines.push("");
  }
  lines.push(`## Ledger (${doc.events.length} events, verbatim)`, "", "```jsonl");
  for (const e of doc.events) lines.push(JSON.stringify(e));
  lines.push("```", "");
  for (const cy of doc.cycles) {
    for (const a of cy.artifacts) {
      if (!a.name.endsWith(".md")) continue;
      lines.push(`## ${a.path} · ${a.sha}`, "", "````markdown", a.content.replace(/\n$/, ""), "````", "");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

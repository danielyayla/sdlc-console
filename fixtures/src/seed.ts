import { blobSha } from "@sdlc/adapter-git";
import { stringifyFrontMatter, stringifyJson, stringifyJsonl, stringifyYaml, type Event } from "@sdlc/schemas";

/**
 * The spec's seed (design-spec §2): 8 changes across all six stages, 2 triage
 * items, 3 findings, plus the repo configuration the console parses. Every
 * artifact sha in the ledger is the real git blob sha of the file content, so
 * SHA chaining holds when the seed is committed to a real repository.
 */

export const PO = "po@veri.example";
export const ENG = "eng@veri.example";
export const PLATFORM = "platform@veri.example";
export const SEC = "security@veri.example";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidCounter = 0;
function ulid(): string {
  ulidCounter += 1;
  let n = ulidCounter;
  let tail = "";
  for (let i = 0; i < 6; i++) {
    tail = (ALPHABET[n % 32] ?? "0") + tail;
    n = Math.floor(n / 32);
  }
  return `01J8SEEDSEEDSEEDSEED${tail}`;
}

const human = (id: string, role: string) => ({ type: "human" as const, id, role });
const agent = (session: string) => ({ type: "agent" as const, id: "claude-code", session });
const system = { type: "system" as const, id: "sdlc-bot" };

function eventsFor(id: string, script: { at: string; actor: Event["actor"]; event: string; data: unknown; cycle?: number }[]): string {
  const events = script.map((s, i) => ({
    schema: 1,
    id: ulid(),
    ts: s.at,
    seq: i + 1,
    cycle: s.cycle ?? 1,
    actor: s.actor,
    event: s.event,
    data: s.data,
  }));
  void id;
  return stringifyJsonl(events);
}

const T = (d: string, h: string) => `2026-${d}T${h}:00Z`;

function intentMd(id: string, title: string, created: string, s: { problem: string; outcome: string; affected: string; constraints: string; questions: string }, author = PO, cycle = 1): string {
  return stringifyFrontMatter(
    { id, artifact: "intent", cycle, author, created, status: "final", context_manifest: "sha256:seed-intent-session", schema: 1 },
    `# Intent: ${title}

## Problem
${s.problem}

## Proposed outcome
${s.outcome}

## Affected users and systems
${s.affected}

## Constraints
${s.constraints}

## Open questions
${s.questions}
`,
  );
}

function specMd(id: string, title: string, intentSha: string, created: string, s: { requirements: string; design: string; concerns: string; carried: string }, concerns: unknown[] = []): string {
  return stringifyFrontMatter(
    { id, artifact: "spec", cycle: 1, intent_sha: intentSha, prompt_ref: "prompts/design-pass@1", skills: [{ name: "brand", version: "1.2.0" }], concerns, created, context_manifest: "sha256:seed-design-pass", schema: 1 },
    `# Spec: ${title}

## Requirements
${s.requirements}

## Design
${s.design}

## Areas of concern
${s.concerns}

## Open questions carried forward
${s.carried}
`,
  );
}

function planMd(id: string, title: string, specSha: string, rev: number, files: string[], acceptance: string, accepted: { by: string; at: string } | null, s: { order: string[]; risks: string; proof: string }): string {
  return stringifyFrontMatter(
    {
      id,
      artifact: "plan",
      cycle: 1,
      spec_sha: specSha,
      rev,
      accepted_by: accepted?.by ?? null,
      accepted_at: accepted?.at ?? null,
      acceptance_line: acceptance,
      context_manifest: "sha256:seed-plan-session",
      schema: 1,
    },
    `# Plan: ${title} (from spec.md ${specSha.slice(0, 12)})

## Files that change
${files.join("\n")}

## Order of work
${s.order.map((o, i) => `${i + 1}. ${o}`).join("\n")}

## Risks
${s.risks}

## Proof
${s.proof}
`,
  );
}

function incidentMd(id: string, title: string, created: string, s: { anomaly: string; outcome: string; affected: string; questions: string }): string {
  return stringifyFrontMatter(
    { id, artifact: "incident", cycle: 1, src: "metric:error_rate", tier: "incident", created, context_manifest: "sha256:seed-diagnose", schema: 1 },
    `# Incident: ${title}

## Anomaly and evidence
${s.anomaly}

## Proposed outcome
${s.outcome}

## Affected systems
${s.affected}

## Open questions
${s.questions}
`,
  );
}

function changeYaml(id: string, title: string, o: { kind?: "feature" | "fix"; risk?: "routine" | "high"; created: string; origin?: { type: string; ref?: string }; repro?: unknown; cycle?: number }): string {
  return stringifyYaml({
    schema: 1,
    id,
    title,
    kind: o.kind ?? "feature",
    risk: o.risk ?? "routine",
    created: { by: PO, at: o.created },
    origin: o.origin ?? { type: "idea" },
    record: null,
    cycle: o.cycle ?? 1,
    repro: o.repro ?? null,
    closed: null,
  });
}

export const CLAUDE_MD = `# Veri invoicing

Working knowledge for agents in this repo. Keep it under one page.

- Make the same mistake twice → add a line here (mistake twice rule).
- Run the verification commands before reporting done; paste output verbatim.

## Commands
- Dev server: \`pnpm dev\`

## Verifying your work
- Build: \`pnpm build\` (must finish with no errors)
- Test: \`pnpm test\` (all green; never skip or delete a failing test)
- Lint: \`pnpm lint\` (zero warnings)
- Test files: \`test/**/*.test.ts\`
- Max rounds: 5
`;

export const SETTINGS_JSON = stringifyJson({
  permissions: {
    allow: ["Bash(pnpm build)", "Bash(pnpm test)", "Bash(pnpm lint)", "Bash(git status)", "Bash(git diff *)"],
    deny: ["Bash(git push *)", "Bash(rm -rf *)"],
  },
  hooks: {
    PreToolUse: [
      { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "sdlc hook test-freeze" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "sdlc hook plan-sync" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "sdlc hook verify-before-done" }] }],
  },
});

export const SKILL_MD = `---
name: brand
description: Use when writing customer-facing copy, invoice templates or UI text for Veri.
owner: marketing@veri.example
backed_by: plan-sync
must_hold: true
---
# Brand voice
Plain, short, no exclamation marks. Currency always with ISO code.
`;

export const AGENT_MD = `---
name: reviewer
description: Reviews a diff against spec.md and plan.md and reports findings by severity.
tools: Read, Grep, Bash(git diff *)
model: sonnet
---
Review the diff. Report bugs, security and compliance findings ranked by severity. Never approve.
`;

export const BANDS_YAML = `baselineWindow: 30d
metrics:
  - metric: p95_latency_ms
    baseline: 310
    unit: ms
    rules: [western-electric]
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep, "Bash(gh run view *)"] }
      3sigma: { action: propose, routes: [pr, "runbook:rollback"] }
  - metric: error_rate_pct
    baseline: 0.4
    unit: "%"
    rules: [western-electric]
    tiers:
      1sigma: { action: log }
      2sigma: { action: diagnose, tools: [Read, Grep] }
      3sigma: { action: propose, routes: [pr] }
runbooks: [rollback]
`;

export const REVIEW_MD = `# Review policy
Passes: bugs, security, compliance vs spec.md and plan.md. Findings inform; humans approve.
`;

export const CONFIG_YAML = stringifyYaml({
  schema: 1,
  defaultRole: "po",
  defaultBranch: "main",
  codeHost: "local",
  identities: [
    { id: PO, name: "Priya Owens", roles: ["po"] },
    { id: ENG, name: "Eli Ng", roles: ["eng", "tech_lead"] },
    { id: PLATFORM, name: "Platform team", roles: ["platform"] },
    { id: SEC, name: "Security lead", roles: ["security"] },
  ],
  thresholds: { autoFilesMax: 12, maxLoopRounds: 5, sessionCeiling: 4, suiteMinSize: 20 },
  records: { intent: "repo", spec: "repo", plan: "repo", evals: "repo", pr: "repo", incident: "repo" },
  evals: { mode: "continuous", threshold: 0.9 },
  eligibility: { coverage: "lenient" },
  products: [{ name: "invoicing", path: "." }],
});

/** Every file of the seed repository, path → content. Deterministic. */
export function seedFiles(): Record<string, string> {
  ulidCounter = 0;
  const files: Record<string, string> = {};
  files["CLAUDE.md"] = CLAUDE_MD;
  files["REVIEW.md"] = REVIEW_MD;
  files["bands.yaml"] = BANDS_YAML;
  files[".claude/settings.json"] = SETTINGS_JSON;
  files[".claude/skills/brand/SKILL.md"] = SKILL_MD;
  files[".claude/agents/reviewer.md"] = AGENT_MD;
  files[".gitattributes"] = "* text=auto eol=lf\nsdlc/**/log.jsonl merge=union\n";
  files[".gitignore"] = "node_modules/\n.sdlc-state/\n";
  files["sdlc/config.yaml"] = CONFIG_YAML;
  files["sdlc/templates/intent.md"] = "---\nid: CHG-0000\nartifact: intent\ncycle: 1\nauthor: \ncreated: \nstatus: draft\nschema: 1\n---\n# Intent: <title>\n\n## Problem\n<what cannot be done today, who is affected>\n\n## Proposed outcome\n<what better looks like>\n\n## Affected users and systems\n\n## Constraints\n\n## Open questions\n";

  const fingerprint = {
    claudeMdSha: blobSha(CLAUDE_MD),
    skills: [{ name: "brand", version: blobSha(SKILL_MD) }],
    hooksSha: blobSha(SETTINGS_JSON),
    model: "claude-opus-5",
  };

  const put = (path: string, content: string) => {
    files[path] = content;
    return blobSha(content);
  };

  // ---------------- CHG-0012 · Maintain (merged, incident recorded, gate 6 open) ----------------
  {
    const id = "CHG-0012";
    const dir = `sdlc/changes/${id}`;
    const title = "Invoice PDF rendering";
    put(`${dir}/change.yaml`, changeYaml(id, title, { created: T("08-20", "09:00") }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("08-20", "09:00"), { problem: "Invoices render as HTML only; customers ask for PDF.", outcome: "A PDF download per invoice, identical to the HTML layout.", affected: "Customers; invoicing web; storage.", constraints: "No third-party rendering service; PDFs under 1 MB.", questions: "None." }));
    const specSha = put(`${dir}/spec.md`, specMd(id, title, intentSha, T("08-20", "11:00"), { requirements: "Render invoice to PDF server-side; link on invoice page.", design: "Headless browser print pipeline behind a queue.", concerns: "C1 privacy: PDFs contain addresses — resolved with expiring links.", carried: "None." }, [{ id: "C1", policy: "privacy", owner: "legal@veri.example", resolved: true, note: "expiring links" }]));
    const planFiles = ["src/invoice/pdf.ts (new)", "src/invoice/route.ts", "test/invoice/pdf.test.ts (new)"];
    put(`${dir}/plan.md`, planMd(id, title, specSha, 2, planFiles, "GET /invoices/:id.pdf returns a PDF under 1 MB for the 3 fixture invoices", { by: ENG, at: T("08-21", "10:00") }, { order: ["render pipeline", "route", "tests"], risks: "Print CSS drift.", proof: "test/invoice/pdf.test.ts + screenshot diff" }));
    put(`${dir}/evals/run-1.json`, stringifyJson({ schema: 1, n: 1, changeId: id, cycle: 1, worktree: `${id}/pdf`, headSha: "b1f3c9a2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2", fileSet: ["src/invoice/pdf.ts", "src/invoice/route.ts", "test/invoice/pdf.test.ts"], configRef: fingerprint, results: [{ caseId: "CASE-0002", pass: true, output: "1 passed" }], commandResults: [{ name: "build", cmd: "pnpm build", exitCode: 0, pass: true, output: "tsc -b\n" }, { name: "test", cmd: "pnpm test", exitCode: 0, pass: true, output: "Tests 41 passed (41)\n" }, { name: "lint", cmd: "pnpm lint", exitCode: 0, pass: true, output: "" }], verdict: "green", startedAt: T("08-22", "14:00"), finishedAt: T("08-22", "14:06") }));
    put(`${dir}/evals/final-round.json`, stringifyJson({ schema: 1, n: 3, ts: T("08-22", "13:50"), results: [{ name: "build", pass: true, exitCode: 0, outputExcerpt: "tsc -b" }, { name: "test", pass: true, exitCode: 0, outputExcerpt: "41 passed" }, { name: "lint", pass: true, exitCode: 0, outputExcerpt: "" }] }));
    put(`${dir}/pr.yaml`, stringifyYaml({ schema: 1, provider: "local", branch: `${id}/pdf`, baseBranch: "main", headSha: "b1f3c9a2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2", openedAt: T("08-22", "14:10"), mergedAt: T("08-23", "09:00"), mergeSha: "c2e4d0b3e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3", reviewers: [ENG], findings: { high: 0, medium: 1, low: 2 }, checks: [{ name: "evidence", verdict: "pass" }], planMatches: true }));
    put(`${dir}/deploy.yaml`, stringifyYaml({ schema: 1, env: "production", version: "2026.08.23", at: T("08-23", "10:00"), status: "succeeded", authorizedBy: ENG, authorizedAt: T("08-23", "09:50") }));
    const incidentSha = put(`${dir}/incident.md`, incidentMd(id, "PDF rendering timeouts after deploy", T("09-02", "07:30"), { anomaly: "error_rate_pct 3.1% vs baseline 0.4% (3σ) since 2026-09-02 06:40; 212 PDF requests timed out at 30 s.", outcome: "PDF rendering under 5 s p95 with no timeouts.", affected: "invoicing web; pdf queue; customers downloading invoices.", questions: "Is the queue starved by the nightly export?" }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("08-20", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "idea" } },
      { at: T("08-20", "09:05"), actor: agent("s-0012-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
      { at: T("08-20", "10:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 1, artifactSha: intentSha, source: "cli" } },
      { at: T("08-20", "10:00"), actor: system, event: "stage.entered", data: { stage: 2 } },
      { at: T("08-20", "11:00"), actor: agent("s-0012-design"), event: "artifact.committed", data: { artifact: 1, path: `${dir}/spec.md`, sha: specSha } },
      { at: T("08-20", "15:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 2, artifactSha: specSha, source: "cli" } },
      { at: T("08-20", "15:00"), actor: system, event: "stage.entered", data: { stage: 3 } },
      { at: T("08-21", "09:00"), actor: agent("s-0012-plan"), event: "plan.drafted", data: { rev: 1 } },
      { at: T("08-21", "09:30"), actor: human(ENG, "eng"), event: "question", data: { text: "What if print CSS drifts?", answer: "screenshot diff in proof" } },
      { at: T("08-21", "09:40"), actor: agent("s-0012-plan"), event: "artifact.committed", data: { artifact: 2, path: `${dir}/plan.md`, sha: blobSha(files[`${dir}/plan.md`] ?? "") } },
      { at: T("08-21", "09:40"), actor: agent("s-0012-plan"), event: "plan.drafted", data: { rev: 2 } },
      { at: T("08-21", "09:41"), actor: agent("s-0012-plan"), event: "plan.final", data: { rev: 2 } },
      { at: T("08-21", "10:00"), actor: human(ENG, "eng"), event: "gate.accepted", data: { gate: 3, artifactSha: blobSha(files[`${dir}/plan.md`] ?? ""), source: "cli" } },
      { at: T("08-21", "10:00"), actor: system, event: "stage.entered", data: { stage: 4 } },
      { at: T("08-22", "13:50"), actor: agent("s-0012-build"), event: "round", data: { n: 3, results: [{ name: "build", pass: true, outputExcerpt: "tsc -b" }, { name: "test", pass: true, outputExcerpt: "41 passed" }, { name: "lint", pass: true, outputExcerpt: "" }] } },
      { at: T("08-22", "14:06"), actor: system, event: "evals.green", data: { run: "run-1", passed: 4, total: 4 } },
      { at: T("08-22", "14:10"), actor: system, event: "pr.opened", data: { headSha: "b1f3c9a2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2" } },
      { at: T("08-22", "14:10"), actor: system, event: "stage.entered", data: { stage: 5 } },
      { at: T("08-22", "16:00"), actor: agent("s-0012-review"), event: "review.finding", data: { severity: "medium", title: "PDF link not expiring for admin role", path: "src/invoice/route.ts" } },
      { at: T("08-23", "09:00"), actor: human(ENG, "eng"), event: "gate.accepted", data: { gate: 5, artifactSha: blobSha(files[`${dir}/pr.yaml`] ?? ""), source: "cli" } },
      { at: T("08-23", "09:00"), actor: human(ENG, "eng"), event: "pr.merged", data: { mergeSha: "c2e4d0b3e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3" } },
      { at: T("08-23", "09:00"), actor: system, event: "stage.entered", data: { stage: 6 } },
      { at: T("08-23", "09:50"), actor: human(ENG, "eng"), event: "deploy.authorized", data: { env: "production", version: "2026.08.23" } },
      { at: T("08-23", "10:00"), actor: system, event: "deploy.finished", data: { env: "production", version: "2026.08.23" } },
      { at: T("09-02", "07:30"), actor: agent("s-0012-diagnose"), event: "artifact.committed", data: { artifact: 5, path: `${dir}/incident.md`, sha: incidentSha } },
    ]);
  }

  // ---------------- CHG-0017 · Deploy (green run, PR open, gate 5) ----------------
  {
    const id = "CHG-0017";
    const dir = `sdlc/changes/${id}`;
    const title = "Invoice CSV export";
    put(`${dir}/change.yaml`, changeYaml(id, title, { created: T("08-26", "09:00"), origin: { type: "ticket", ref: "JIRA-4411" } }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("08-26", "09:00"), { problem: "Finance re-keys invoices into spreadsheets every month.", outcome: "One CSV per month with all invoice lines.", affected: "Finance team; invoicing API.", constraints: "No PII beyond invoice ids and totals.", questions: "None." }));
    const specSha = put(`${dir}/spec.md`, specMd(id, title, intentSha, T("08-26", "11:00"), { requirements: "GET /export?month=YYYY-MM returns CSV.", design: "Streaming CSV from the invoice repository.", concerns: "None flagged.", carried: "None." }));
    const planFiles = ["src/export/csv.ts (new)", "src/export/route.ts (new)", "test/export/csv.test.ts (new)"];
    put(`${dir}/plan.md`, planMd(id, title, specSha, 1, planFiles, "GET /export?month=2026-08 returns 3 fixture invoices as CSV; tests pass", { by: ENG, at: T("08-27", "10:00") }, { order: ["csv writer", "route", "tests"], risks: "Large months stream slowly.", proof: "test/export/csv.test.ts" }));
    const head = "d3f5e1c4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4";
    put(`${dir}/evals/run-1.json`, stringifyJson({ schema: 1, n: 1, changeId: id, cycle: 1, worktree: `${id}/export`, headSha: head, fileSet: ["src/export/csv.ts", "src/export/route.ts", "test/export/csv.test.ts"], configRef: fingerprint, results: [{ caseId: "CASE-0001", pass: true, output: "1 passed" }], commandResults: [{ name: "build", cmd: "pnpm build", exitCode: 0, pass: true, output: "tsc -b\n" }, { name: "test", cmd: "pnpm test", exitCode: 0, pass: true, output: "Tests 44 passed (44)\n" }, { name: "lint", cmd: "pnpm lint", exitCode: 0, pass: true, output: "" }], verdict: "green", startedAt: T("09-01", "16:00"), finishedAt: T("09-01", "16:05") }));
    put(`${dir}/evals/final-round.json`, stringifyJson({ schema: 1, n: 2, ts: T("09-01", "15:50"), results: [{ name: "build", pass: true, exitCode: 0, outputExcerpt: "tsc -b" }, { name: "test", pass: true, exitCode: 0, outputExcerpt: "44 passed" }, { name: "lint", pass: true, exitCode: 0, outputExcerpt: "" }] }));
    put(`${dir}/pr.yaml`, stringifyYaml({ schema: 1, provider: "local", branch: `${id}/export`, baseBranch: "main", headSha: head, openedAt: T("09-01", "16:10"), reviewers: [ENG], findings: { high: 0, medium: 0, low: 1 }, checks: [{ name: "evidence", verdict: "pass" }], planMatches: true }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("08-26", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "ticket:JIRA-4411" } },
      { at: T("08-26", "09:05"), actor: agent("s-0017-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
      { at: T("08-26", "10:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 1, artifactSha: intentSha, source: "cli" } },
      { at: T("08-26", "10:00"), actor: system, event: "stage.entered", data: { stage: 2 } },
      { at: T("08-26", "11:00"), actor: agent("s-0017-design"), event: "artifact.committed", data: { artifact: 1, path: `${dir}/spec.md`, sha: specSha } },
      { at: T("08-26", "14:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 2, artifactSha: specSha, source: "cli" } },
      { at: T("08-26", "14:00"), actor: system, event: "stage.entered", data: { stage: 3 } },
      { at: T("08-27", "09:30"), actor: agent("s-0017-plan"), event: "artifact.committed", data: { artifact: 2, path: `${dir}/plan.md`, sha: blobSha(files[`${dir}/plan.md`] ?? "") } },
      { at: T("08-27", "09:30"), actor: agent("s-0017-plan"), event: "plan.final", data: { rev: 1 } },
      { at: T("08-27", "10:00"), actor: human(ENG, "eng"), event: "gate.accepted", data: { gate: 3, artifactSha: blobSha(files[`${dir}/plan.md`] ?? ""), source: "cli" } },
      { at: T("08-27", "10:00"), actor: system, event: "stage.entered", data: { stage: 4 } },
      { at: T("08-27", "10:05"), actor: agent("s-0017-plan"), event: "tasks.proposed", data: { tasks: [{ id: "export", title: "Work in src/export", files: ["src/export/csv.ts", "src/export/route.ts"], sequential: false }, { id: "test", title: "Work in test/export", files: ["test/export/csv.test.ts"], sequential: false }] } },
      { at: T("08-27", "10:10"), actor: human(ENG, "eng"), event: "tasks.confirmed", data: { taskIds: ["export", "test"] } },
      { at: T("09-01", "15:50"), actor: agent("s-0017-build"), event: "round", data: { n: 2, results: [{ name: "build", pass: true, outputExcerpt: "tsc -b" }, { name: "test", pass: true, outputExcerpt: "44 passed" }, { name: "lint", pass: true, outputExcerpt: "" }] } },
      { at: T("09-01", "15:55"), actor: agent("s-0017-build"), event: "hook.allowed", data: { hook: "plan-sync" } },
      { at: T("09-01", "16:05"), actor: system, event: "evals.green", data: { run: "run-1", passed: 4, total: 4 } },
      { at: T("09-01", "16:10"), actor: system, event: "pr.opened", data: { headSha: head } },
      { at: T("09-01", "16:10"), actor: system, event: "stage.entered", data: { stage: 5 } },
    ]);
    put(`${dir}/tasks.yaml`, stringifyYaml({ schema: 1, changeId: id, cycle: 1, tasks: [{ id: "export", title: "Work in src/export", files: ["src/export/csv.ts", "src/export/route.ts"], sequential: false, target: "GET /export?month=2026-08 returns 3 fixture invoices as CSV; tests pass", worktree: `${id}/export`, branch: `${id}/export`, state: "done" }, { id: "test", title: "Work in test/export", files: ["test/export/csv.test.ts"], sequential: false, target: "tests pass", worktree: `${id}/test`, branch: `${id}/test`, state: "done" }] }));
  }

  // ---------------- CHG-0018 · Test (fix, repro committed, one red run) ----------------
  {
    const id = "CHG-0018";
    const dir = `sdlc/changes/${id}`;
    const title = "Export drops invoices with zero total";
    const reproSha = "e4a6f2d5a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5";
    put(`${dir}/change.yaml`, changeYaml(id, title, { kind: "fix", created: T("08-29", "09:00"), origin: { type: "channel", ref: "slack:#finance" }, repro: { state: "committed", testPath: "test/export/zero-total.test.ts", failureReason: "expected 4 rows, received 3", sha: reproSha } }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("08-29", "09:00"), { problem: "Invoices with a zero total are missing from the CSV export.", outcome: "Every invoice of the month appears, zero totals included.", affected: "Finance; export API.", constraints: "Failing test first; no other test changes.", questions: "None." }));
    const specSha = put(`${dir}/spec.md`, specMd(id, title, intentSha, T("08-29", "10:00"), { requirements: "Rows with total 0 are exported.", design: "Remove the truthiness filter in the row mapper.", concerns: "None flagged.", carried: "None." }));
    put(`${dir}/plan.md`, planMd(id, title, specSha, 1, ["src/export/csv.ts", "test/export/zero-total.test.ts (new)"], "test/export/zero-total.test.ts passes; no other test changes", { by: ENG, at: T("08-29", "11:00") }, { order: ["repro test", "fix filter"], risks: "None.", proof: "repro test green, unchanged in diff" }));
    put(`${dir}/evals/repro.json`, stringifyJson({ schema: 1, testPath: "test/export/zero-total.test.ts", failureReason: "expected 4 rows, received 3", sha: reproSha, output: "AssertionError: expected 4 rows, received 3\n  at test/export/zero-total.test.ts:12:5", confirmedBy: ENG, confirmedAt: T("09-02", "09:00") }));
    put(`${dir}/evals/run-1.json`, stringifyJson({ schema: 1, n: 1, changeId: id, cycle: 1, worktree: `${id}/export-fix`, headSha: "f5b7a3e6b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6", fileSet: ["src/export/csv.ts"], configRef: fingerprint, results: [{ caseId: "CASE-0001", pass: false, output: "1 failed: zero-total row missing" }], commandResults: [{ name: "build", cmd: "pnpm build", exitCode: 0, pass: true, output: "tsc -b\n" }, { name: "test", cmd: "pnpm test", exitCode: 1, pass: false, output: "Tests 1 failed | 44 passed (45)\n  ✗ zero-total row missing\n" }, { name: "lint", cmd: "pnpm lint", exitCode: 0, pass: true, output: "" }], verdict: "red", startedAt: T("09-02", "09:30"), finishedAt: T("09-02", "09:34") }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("08-29", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "channel:slack:#finance" } },
      { at: T("08-29", "09:05"), actor: agent("s-0018-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
      { at: T("08-29", "09:30"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 1, artifactSha: intentSha, source: "cli" } },
      { at: T("08-29", "09:30"), actor: system, event: "stage.entered", data: { stage: 2 } },
      { at: T("08-29", "10:00"), actor: agent("s-0018-design"), event: "artifact.committed", data: { artifact: 1, path: `${dir}/spec.md`, sha: specSha } },
      { at: T("08-29", "10:30"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 2, artifactSha: specSha, source: "cli" } },
      { at: T("08-29", "10:30"), actor: system, event: "stage.entered", data: { stage: 3 } },
      { at: T("08-29", "10:50"), actor: agent("s-0018-plan"), event: "artifact.committed", data: { artifact: 2, path: `${dir}/plan.md`, sha: blobSha(files[`${dir}/plan.md`] ?? "") } },
      { at: T("08-29", "10:50"), actor: agent("s-0018-plan"), event: "plan.final", data: { rev: 1 } },
      { at: T("08-29", "11:00"), actor: human(ENG, "eng"), event: "gate.accepted", data: { gate: 3, artifactSha: blobSha(files[`${dir}/plan.md`] ?? ""), source: "cli" } },
      { at: T("08-29", "11:00"), actor: system, event: "stage.entered", data: { stage: 4 } },
      { at: T("09-02", "08:50"), actor: agent("sess-0018-repro"), event: "repro.failed", data: { testPath: "test/export/zero-total.test.ts", failureReason: "expected 4 rows, received 3" } },
      { at: T("09-02", "09:00"), actor: human(ENG, "eng"), event: "repro.confirmed", data: { testPath: "test/export/zero-total.test.ts", sha: reproSha } },
      { at: T("09-02", "09:20"), actor: agent("sess-0018-repro"), event: "hook.blocked", data: { hook: "test-freeze", reason: "test freeze active", path: "test/export/csv.test.ts" } },
      { at: T("09-02", "09:34"), actor: system, event: "evals.red", data: { run: "run-1", passed: 3, total: 4 } },
    ]);
    put(`${dir}/tasks.yaml`, stringifyYaml({ schema: 1, changeId: id, cycle: 1, tasks: [{ id: "export-fix", title: "Fix zero-total filter", files: ["src/export/csv.ts", "test/export/zero-total.test.ts"], sequential: false, target: "test/export/zero-total.test.ts passes; no other test changes", worktree: `${id}/export-fix`, branch: `${id}/export-fix`, state: "running" }] }));
  }

  // ---------------- CHG-0019 · Build, high risk (plan final, tech lead via PR) ----------------
  {
    const id = "CHG-0019";
    const dir = `sdlc/changes/${id}`;
    const title = "Payment provider migration";
    put(`${dir}/change.yaml`, changeYaml(id, title, { risk: "high", created: T("08-30", "09:00") }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("08-30", "09:00"), { problem: "The current payment provider is sunsetting its API in Q4.", outcome: "Payments run on the new provider with no customer-visible change.", affected: "Checkout; billing; every paying customer.", constraints: "Dual-run for two weeks; PCI scope unchanged.", questions: "Refund history migration?" }));
    const specSha = put(`${dir}/spec.md`, specMd(id, title, intentSha, T("08-30", "13:00"), { requirements: "Provider adapter interface; feature flag; dual-run reconciliation.", design: "Adapter behind PaymentGateway; flag per tenant.", concerns: "C1 compliance (PCI) — resolved with security lead; C2 tech lead consulted.", carried: "Refund history migration." }, [{ id: "C1", policy: "compliance", owner: SEC, resolved: true }]));
    put(`${dir}/plan.md`, planMd(id, title, specSha, 3, ["src/payments/gateway.ts", "src/payments/providers/newco.ts (new)", "src/payments/flags.ts (new)", "src/checkout/pay.ts", "test/payments/newco.test.ts (new)", "test/payments/reconcile.test.ts (new)"], "dual-run reconciliation shows 0 mismatches over the fixture ledger; all tests pass", null, { order: ["adapter", "flag", "checkout wiring", "reconciliation tests"], risks: "Webhook signature differences; refund mapping.", proof: "test/payments/*; reconciliation report" }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("08-30", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "idea" } },
      { at: T("08-30", "09:05"), actor: agent("s-0019-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
      { at: T("08-30", "10:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 1, artifactSha: intentSha, source: "cli" } },
      { at: T("08-30", "10:00"), actor: system, event: "stage.entered", data: { stage: 2 } },
      { at: T("08-30", "13:00"), actor: agent("s-0019-design"), event: "artifact.committed", data: { artifact: 1, path: `${dir}/spec.md`, sha: specSha } },
      { at: T("08-30", "15:00"), actor: human(ENG, "tech_lead"), event: "consult.tech_lead", data: { by: ENG, note: "dual-run required" } },
      { at: T("08-30", "16:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 2, artifactSha: specSha, source: "cli" } },
      { at: T("08-30", "16:00"), actor: system, event: "stage.entered", data: { stage: 3 } },
      { at: T("09-01", "15:10"), actor: agent("sess-0019-plan"), event: "plan.drafted", data: { rev: 1 } },
      { at: T("09-01", "15:40"), actor: agent("sess-0019-plan"), event: "plan.drafted", data: { rev: 2 } },
      { at: T("09-01", "16:00"), actor: human(ENG, "eng"), event: "question", data: { text: "Riskiest step?", answer: "checkout wiring under the flag" } },
      { at: T("09-01", "16:15"), actor: agent("sess-0019-plan"), event: "artifact.committed", data: { artifact: 2, path: `${dir}/plan.md`, sha: blobSha(files[`${dir}/plan.md`] ?? "") } },
      { at: T("09-01", "16:15"), actor: agent("sess-0019-plan"), event: "plan.drafted", data: { rev: 3 } },
      { at: T("09-01", "16:16"), actor: agent("sess-0019-plan"), event: "plan.final", data: { rev: 3 } },
    ]);
  }

  // ---------------- CHG-0020 · Build, routine (plan final, gate 3 engineer, AUTO eligible) ----------------
  {
    const id = "CHG-0020";
    const dir = `sdlc/changes/${id}`;
    const title = "Export column order matches the finance template";
    put(`${dir}/change.yaml`, changeYaml(id, title, { created: T("08-31", "09:00") }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("08-31", "09:00"), { problem: "Finance re-orders CSV columns by hand to match their template.", outcome: "CSV columns come out in the template order.", affected: "Finance; export API.", constraints: "No new columns.", questions: "None." }));
    const specSha = put(`${dir}/spec.md`, specMd(id, title, intentSha, T("08-31", "10:00"), { requirements: "Column order: id, date, customer, total, currency.", design: "Ordered header constant in the CSV writer.", concerns: "None flagged.", carried: "None." }));
    put(`${dir}/plan.md`, planMd(id, title, specSha, 2, ["src/export/csv.ts", "test/export/csv.test.ts"], "test/export/csv.test.ts asserts the 5-column order and passes", null, { order: ["header constant", "test"], risks: "None.", proof: "test/export/csv.test.ts" }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("08-31", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "idea" } },
      { at: T("08-31", "09:05"), actor: agent("s-0020-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
      { at: T("08-31", "09:30"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 1, artifactSha: intentSha, source: "cli" } },
      { at: T("08-31", "09:30"), actor: system, event: "stage.entered", data: { stage: 2 } },
      { at: T("08-31", "10:00"), actor: agent("s-0020-design"), event: "artifact.committed", data: { artifact: 1, path: `${dir}/spec.md`, sha: specSha } },
      { at: T("08-31", "10:30"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 2, artifactSha: specSha, source: "cli" } },
      { at: T("08-31", "10:30"), actor: system, event: "stage.entered", data: { stage: 3 } },
      { at: T("09-02", "08:10"), actor: agent("sess-0020-plan"), event: "plan.drafted", data: { rev: 1 } },
      { at: T("09-02", "08:40"), actor: agent("sess-0020-plan"), event: "artifact.committed", data: { artifact: 2, path: `${dir}/plan.md`, sha: blobSha(files[`${dir}/plan.md`] ?? "") } },
      { at: T("09-02", "08:40"), actor: agent("sess-0020-plan"), event: "plan.drafted", data: { rev: 2 } },
      { at: T("09-02", "08:41"), actor: agent("sess-0020-plan"), event: "plan.final", data: { rev: 2 } },
    ]);
  }

  // ---------------- CHG-0021 · Design (spec committed, gate 2 open) ----------------
  {
    const id = "CHG-0021";
    const dir = `sdlc/changes/${id}`;
    const title = "Customer portal invoice search";
    put(`${dir}/change.yaml`, changeYaml(id, title, { created: T("09-01", "09:00") }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("09-01", "09:00"), { problem: "Customers scroll through pages of invoices to find one.", outcome: "Search by number, date range and amount on the portal.", affected: "Customers; portal web; invoice index.", constraints: "Brand voice; no new PII exposure.", questions: "Fuzzy matching on customer names?" }));
    const specSha = put(`${dir}/spec.md`, specMd(id, title, intentSha, T("09-01", "11:00"), { requirements: "Search box with number/date/amount filters; results under 300 ms.", design: "Indexed query on the invoice read model; debounced client.", concerns: "C1 brand: copy reviewed by marketing (open).", carried: "Fuzzy matching on customer names." }, [{ id: "C1", policy: "brand", owner: "marketing@veri.example", resolved: false }]));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("09-01", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "idea" } },
      { at: T("09-01", "09:05"), actor: agent("s-0021-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
      { at: T("09-01", "10:00"), actor: human(PO, "po"), event: "gate.accepted", data: { gate: 1, artifactSha: intentSha, source: "cli" } },
      { at: T("09-01", "10:00"), actor: system, event: "stage.entered", data: { stage: 2 } },
      { at: T("09-01", "11:06"), actor: agent("sess-0021-design"), event: "artifact.committed", data: { artifact: 1, path: `${dir}/spec.md`, sha: specSha } },
    ]);
  }

  // ---------------- CHG-0022 · Plan (intent committed, gate 1 open) ----------------
  {
    const id = "CHG-0022";
    const dir = `sdlc/changes/${id}`;
    const title = "Multi-currency invoice totals";
    put(`${dir}/change.yaml`, changeYaml(id, title, { created: T("09-02", "09:00") }));
    const intentSha = put(`${dir}/intent.md`, intentMd(id, title, T("09-02", "09:00"), { problem: "Invoices in EUR and GBP show totals without a currency, so finance mis-books them.", outcome: "Every total carries its ISO currency code and a converted base-currency figure.", affected: "Finance; customers outside the US; invoicing API and PDF.", constraints: "Rates from the existing FX feed only.", questions: "Round at line or at total?" }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("09-02", "09:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "idea" } },
      { at: T("09-02", "09:12"), actor: agent("s-0022-intent"), event: "artifact.committed", data: { artifact: 0, path: `${dir}/intent.md`, sha: intentSha } },
    ]);
  }

  // ---------------- CHG-0023 · Plan (agent drafting intent) ----------------
  {
    const id = "CHG-0023";
    const dir = `sdlc/changes/${id}`;
    put(`${dir}/change.yaml`, changeYaml(id, "Dunning reminders schedule", { created: T("09-02", "10:00") }));
    files[`${dir}/log.jsonl`] = eventsFor(id, [
      { at: T("09-02", "10:00"), actor: human(PO, "po"), event: "change.created", data: { origin: "idea" } },
      { at: T("09-02", "10:01"), actor: agent("s-0023-intent"), event: "question", data: { text: "How many reminders before escalation?" } },
    ]);
  }

  // ---------------- triage ----------------
  files["sdlc/loop/triage/TRI-0042.md"] = stringifyFrontMatter(
    { schema: 1, id: "TRI-0042", tier: "3σ", src: "metric:p95_latency_ms", title: "Export p95 latency breached 3σ", evidence: "p95_latency_ms = 840 vs baseline 310 (rolling 30d); 6 of last 8 samples above 2σ (Western Electric rule 2).", createdAt: T("09-02", "06:00"), status: "open" },
    `# Intent: Export p95 latency breached 3σ

## Problem
Export requests take 840 ms at p95 against a 310 ms baseline since the CSV streaming change; finance reports timeouts on large months.

## Proposed outcome
Export p95 back under 400 ms with no change to the CSV content.

## Affected users and systems
Finance; export API; invoice read model.

## Constraints
No schema migration; keep streaming.

## Open questions
Is the read model missing an index on (month, customer)?
`,
  );
  files["sdlc/loop/triage/TRI-0043.md"] = stringifyFrontMatter(
    { schema: 1, id: "TRI-0043", tier: "incident", src: "channel:slack:#support", title: "Duplicate invoice numbers after retry", evidence: "3 support tickets; invoices 10231 and 10231-dup issued to different customers.", createdAt: T("09-02", "08:30"), status: "open" },
    `# Intent: Duplicate invoice numbers after retry

## Problem
A retried creation request can issue the same invoice number twice.

## Proposed outcome
Invoice numbers are unique under retries.

## Affected users and systems
Customers; invoice numbering service.

## Constraints
No renumbering of issued invoices.

## Open questions
Idempotency key at the API edge or in the numbering service?
`,
  );

  // ---------------- findings ----------------
  files["sdlc/security/findings/SEC-0118.yaml"] = stringifyYaml({ schema: 1, id: "SEC-0118", scannerId: "claude-security:7f3a91", sev: "high", conf: 0.94, validated: true, repo: "invoicing", title: "SQL injection in invoice filter", desc: "User-supplied `sort` reaches the query builder unescaped in src/invoice/list.ts.", status: "new" });
  files["sdlc/security/findings/SEC-0119.yaml"] = stringifyYaml({ schema: 1, id: "SEC-0119", scannerId: "claude-security:2c8d10", sev: "medium", conf: 0.81, validated: true, repo: "invoicing", title: "PDF links do not expire for admin role", desc: "Admin-generated PDF links are signed without an expiry claim.", status: "new" });
  files["sdlc/security/findings/SEC-0120.yaml"] = stringifyYaml({ schema: 1, id: "SEC-0120", scannerId: "claude-security:9be442", sev: "low", conf: 0.66, validated: true, repo: "invoicing", title: "Verbose error page in staging", desc: "Stack traces returned on 500 in the staging environment.", status: "patch_pr", patchPr: { number: 418 } });

  // ---------------- proposals ----------------
  files["sdlc/proposals/PRP-0007.yaml"] = stringifyYaml({ schema: 1, id: "PRP-0007", type: "claude-md-line", text: "Never filter invoice rows by truthiness of the total; zero is a valid amount.", citations: ["CHG-0018", "CHG-0004"], status: "open", createdAt: T("09-02", "09:40") });

  // ---------------- evals ----------------
  files["evals/cases/CASE-0001.json"] = stringifyJson({ schema: 1, id: "CASE-0001", prompt: "Export a month of invoices as CSV and verify every invoice appears once with the template column order.", checks: [{ name: "test", cmd: "pnpm test -- test/export", healthyOutput: "passed" }], source: { type: "change", ref: "CHG-0017" }, owner: PLATFORM, added: T("08-27", "12:00"), status: "active", paths: ["src/export/csv.ts", "src/export/route.ts", "test/export/csv.test.ts"] });
  files["evals/cases/CASE-0002.json"] = stringifyJson({ schema: 1, id: "CASE-0002", prompt: "Render the three fixture invoices to PDF and verify size and layout.", checks: [{ name: "test", cmd: "pnpm test -- test/invoice/pdf", healthyOutput: "passed" }], source: { type: "change", ref: "CHG-0012" }, owner: PLATFORM, added: T("08-23", "12:00"), status: "active", paths: ["src/invoice/pdf.ts", "src/invoice/route.ts", "test/invoice/pdf.test.ts"] });
  files["evals/cases/CASE-0003.json"] = stringifyJson({ schema: 1, id: "CASE-0003", prompt: "Search invoices by number on the portal.", checks: [], source: { type: "manual" }, owner: PLATFORM, added: T("09-01", "12:00"), status: "draft", paths: ["src/portal/search.ts"] });
  files["evals/runs/RUN-0001.json"] = stringifyJson({ schema: 1, id: "RUN-0001", trigger: "schedule", configRef: fingerprint, results: [{ caseId: "CASE-0001", pass: true, output: "1 passed" }, { caseId: "CASE-0002", pass: true, output: "1 passed" }], passRate: 1, threshold: 0.9, verdict: "pass", cost: 1.42, startedAt: T("09-02", "03:00"), finishedAt: T("09-02", "03:09") });

  return files;
}

export const SEED_CHANGE_IDS = ["CHG-0012", "CHG-0017", "CHG-0018", "CHG-0019", "CHG-0020", "CHG-0021", "CHG-0022", "CHG-0023"] as const;

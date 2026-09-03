import type { Event, EventName, EventOf } from "@sdlc/schemas";
import { configFingerprint, deriveChange, loadRepo, treeFromRecord, withFiles, type ChangeFiles, type ChangeView, type Repo, type Tree } from "../src/index.js";

/** Loaded files for a change, or throw (tests only). */
export function filesOf(repo: Repo, id: string): ChangeFiles {
  const files = repo.changes.get(id);
  if (!files) throw new Error(`no ${id} in repo`);
  return files;
}

/** Load + derive one change from a tree (tests only). */
export function viewOf(tree: Tree, id: string): { repo: Repo; files: ChangeFiles; view: ChangeView } {
  const repo = loadRepo(tree);
  const files = filesOf(repo, id);
  return { repo, files, view: deriveChange(repo, files) };
}

export const TS = "2026-09-03T10:00:00Z";
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const PO = { type: "human", id: "po@example.com", role: "po" } as const;
export const ENG = { type: "human", id: "eng@example.com", role: "eng" } as const;
export const AGENT = { type: "agent", id: "claude-code", session: "sess-1" } as const;
export const SYSTEM = { type: "system", id: "sdlc-bot" } as const;

let seq = 0;
let ulidCounter = 0;
export function resetSeq(): void {
  seq = 0;
  ulidCounter = 0;
}
function nextUlid(): string {
  ulidCounter++;
  return `01J8Z6Q7Y2K3M4N5P6Q7R8${ulidCounter.toString(36).toUpperCase().padStart(4, "0")}`.replace(/[ILOU]/g, "X");
}

export function ev<N extends EventName>(name: N, actor: Event["actor"], data: EventOf<N>["data"], cycle = 1, ts = TS): Event {
  seq++;
  const minutes = String(seq).padStart(2, "0");
  return {
    schema: 1,
    id: nextUlid(),
    ts: ts.replace(":00:00Z", `:${minutes}:00Z`),
    seq,
    cycle,
    actor,
    event: name,
    data,
  } as unknown as Event;
}

export const baseTree = (): Tree =>
  treeFromRecord({
    "CLAUDE.md": "# P\n\n## Verifying your work\n- Build: `pnpm build`\n- Test: `pnpm test` (all green)\n- Lint: `pnpm lint`\n- Test files: `test/**/*.test.ts`\n",
    "sdlc/config.yaml": "schema: 1\ndefaultRole: po\nidentities:\n  - { id: po@example.com, roles: [po] }\n  - { id: eng@example.com, roles: [eng, tech_lead] }\nthresholds: { autoFilesMax: 3 }\n",
    ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "sdlc hook verify-before-done" }] }] } }),
  });

export interface ChangeSpec {
  id: string;
  title?: string;
  kind?: "feature" | "fix";
  risk?: "routine" | "high";
  cycle?: number;
  origin?: { type: "idea" | "ticket" | "triage" | "security" | "incident" | "channel"; ref?: string };
  intent?: boolean;
  spec?: boolean;
  plan?: boolean | { files: string[]; rev?: number; accepted?: boolean };
  incident?: boolean;
  pr?: { merged?: boolean; openedAt?: string };
  runs?: ("green" | "red" | "green-stale")[];
  events?: Event[];
}

const artifactBody = (kind: string, sections: string[]) =>
  `# ${kind}: T\n\n${sections.map((s) => `## ${s}\nfilled\n`).join("\n")}`;

export function changeFiles(tree: Tree, c: ChangeSpec): Record<string, string> {
  const dir = `sdlc/changes/${c.id}`;
  const cycle = c.cycle ?? 1;
  const files: Record<string, string> = {};
  files[`${dir}/change.yaml`] = `schema: 1
id: ${c.id}
title: ${c.title ?? `Change ${c.id}`}
kind: ${c.kind ?? "feature"}
risk: ${c.risk ?? "routine"}
created: { by: po@example.com, at: "${TS}" }
origin: { type: ${c.origin?.type ?? "idea"}${c.origin?.ref ? `, ref: "${c.origin.ref}"` : ""} }
record: null
cycle: ${cycle}
repro: null
closed: null
`;
  if (c.intent) {
    files[`${dir}/intent.md`] = `---\nid: ${c.id}\nartifact: intent\ncycle: ${cycle}\nauthor: po@example.com\ncreated: ${TS}\nschema: 1\n---\n${artifactBody("Intent", ["Problem", "Proposed outcome", "Affected users and systems", "Constraints", "Open questions"])}`;
  }
  if (c.spec) {
    files[`${dir}/spec.md`] = `---\nid: ${c.id}\nartifact: spec\ncycle: ${cycle}\nintent_sha: ${SHA}\nskills: []\nconcerns: []\ncreated: ${TS}\nschema: 1\n---\n${artifactBody("Spec", ["Requirements", "Design", "Areas of concern", "Open questions carried forward"])}`;
  }
  if (c.plan) {
    const p = c.plan === true ? { files: ["src/a.ts", "src/b.ts"] } : c.plan;
    const accepted = p.accepted ?? false;
    files[`${dir}/plan.md`] = `---\nid: ${c.id}\nartifact: plan\ncycle: ${cycle}\nspec_sha: ${SHA}\nrev: ${p.rev ?? 1}\naccepted_by: ${accepted ? "eng@example.com" : "null"}\naccepted_at: ${accepted ? TS : "null"}\nacceptance_line: "tests pass"\nschema: 1\n---\n# Plan: T\n\n## Files that change\n${p.files.map((f) => `${f} (new)`).join("\n")}\n\n## Order of work\n1. do it\n\n## Risks\nnone\n\n## Proof\ntests\n`;
  }
  if (c.incident) {
    files[`${dir}/incident.md`] = `---\nid: ${c.id}\nartifact: incident\ncycle: ${cycle}\nsrc: metric:errors\ntier: incident\ncreated: ${TS}\nschema: 1\n---\n${artifactBody("Incident", ["Anomaly and evidence", "Proposed outcome", "Affected systems", "Open questions"])}`;
  }
  if (c.pr) {
    files[`${dir}/pr.yaml`] = `schema: 1\nprovider: local\nbranch: ${c.id}/work\nbaseBranch: main\nheadSha: ${SHA}\nopenedAt: ${c.pr.openedAt ?? "2026-09-03T12:00:00Z"}\n${c.pr.merged ? `mergedAt: 2026-09-03T13:00:00Z\nmergeSha: ${SHA}\n` : ""}reviewers: []\nchecks: []\nplanMatches: true\n`;
  }
  const fp = configFingerprint(tree);
  (c.runs ?? []).forEach((verdict, i) => {
    const ref = verdict === "green-stale" ? { ...fp, claudeMdSha: SHA } : fp;
    files[`${dir}/evals/run-${i + 1}.json`] = JSON.stringify({
      schema: 1,
      n: i + 1,
      changeId: c.id,
      cycle,
      worktree: `${c.id}/work`,
      headSha: SHA,
      fileSet: ["src/a.ts"],
      configRef: ref,
      results: [],
      commandResults: [{ name: "test", cmd: "pnpm test", exitCode: verdict === "red" ? 1 : 0, pass: verdict !== "red", output: "…" }],
      verdict: verdict === "red" ? "red" : "green",
      startedAt: TS,
    });
  });
  if (c.events && c.events.length > 0) {
    files[`${dir}/log.jsonl`] = c.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
  return files;
}

export function withChange(tree: Tree, c: ChangeSpec): Tree {
  return withFiles(tree, changeFiles(tree, c));
}

/** Standard event scripts to reach a stage. */
export function acceptedThrough(gates: number[], cycle = 1): Event[] {
  const out: Event[] = [];
  const idxFor: Record<number, number> = { 1: 0, 2: 1, 3: 2, 6: 5 };
  for (const g of gates) {
    const idx = idxFor[g] ?? 0;
    out.push(ev("artifact.committed", AGENT, { artifact: idx, path: `x`, sha: SHA }, cycle));
    const actor = g === 3 ? ENG : PO;
    out.push(ev("gate.accepted", actor, { gate: g as 1 | 2 | 3 | 5 | 6, artifactSha: SHA, source: "cli" }, cycle));
  }
  return out;
}

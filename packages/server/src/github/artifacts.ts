import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, blobSha, CodeHostError, commitWritePlan, currentBranch, fetchRemote, git, gitRaw, headSha, listWorktrees, mergeRemoteBranch, newUlid, pushBranch, removeWorktree, type GitIdentity } from "@sdlc/adapter-git";
import { assertProtected, findOpenPull, getPull, GitHubError, mergePull, openPull, requestChanges, type GitHubCodeHost } from "@sdlc/adapter-github";
import { accept, ARTIFACT_INDEX_FOR_GATE, deriveChange, identityForGitHubLogin, recordArtifactPr, sendBack, stageDef, validateWritePlan, type ArtifactIndex, type ChangeView, type Repo, type TransitionContext, type TransitionResult, type WritePlan } from "@sdlc/core";
import type { GateNumber } from "@sdlc/schemas";
import { ActionError, StateStore } from "../store.js";

export interface GitHubMode {
  host: GitHubCodeHost;
  identity: GitIdentity;
  now?: () => Date;
  log?: (line: string) => void;
}

const ROLE_RULES = /(not-owner|not-engineer|not-po|gate\.via)/;

function refused(result: Extract<TransitionResult, { ok: false }>): ActionError {
  const first = result.diagnostics[0];
  const status = first && ROLE_RULES.test(first.rule) ? 403 : first?.rule.endsWith(".missing") ? 404 : 409;
  return new ActionError(status, first?.message ?? "refused", result.diagnostics);
}

function hostError(e: unknown): ActionError {
  if (e instanceof ActionError) return e;
  const retryable = e instanceof CodeHostError ? e.retryable : e instanceof GitHubError ? e.retryable : true;
  return new ActionError(retryable ? 502 : 409, (e as Error).message, [], retryable);
}

function iso(mode: GitHubMode): string {
  return (mode.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function context(mode: GitHubMode, actor: GitIdentity, extra: Partial<TransitionContext> = {}): TransitionContext {
  return { now: iso(mode), newId: newUlid, actor, blobSha, ...extra };
}

export const ARTIFACT_OF_INDEX: Partial<Record<ArtifactIndex, "intent" | "spec" | "plan" | "incident">> = { 0: "intent", 1: "spec", 2: "plan", 5: "incident" };

export function artifactBranchFor(changeId: string, index: ArtifactIndex): string | null {
  const name = ARTIFACT_OF_INDEX[index];
  return name ? `sdlc/${changeId}/${name}` : null;
}

/** Run `fn` inside a worktree checked out on `branch`: the session's existing one, or a temporary one removed afterwards. */
export async function withBranchWorktree<T>(root: string, branch: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const existing = (await listWorktrees(root)).find((w) => w.branch === branch);
  if (existing) return fn(existing.path);
  const dir = mkdtempSync(join(root, ".sdlc-state", "worktrees", "tmp-"));
  try {
    rmSync(dir, { recursive: true, force: true });
    await addWorktree(root, dir, branch);
    return await fn(dir);
  } finally {
    await removeWorktree(root, dir, true).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Commit a write-plan on an artifact branch (decision rides with the artifact into the merge). */
export function commitOnBranch(root: string, branch: string, plan: WritePlan, identity: GitIdentity): Promise<string> {
  return withBranchWorktree(root, branch, (dir) => commitWritePlan(dir, plan, { identity }));
}

function viewFor(repo: Repo, id: string): ChangeView {
  const files = repo.changes.get(id);
  if (!files) throw new ActionError(404, `${id} not found`);
  return deriveChange(repo, files);
}

function requireOnBase(root: string, base: string): Promise<void> {
  return currentBranch(root).then((current) => {
    if (current !== base) throw new ActionError(409, `GitHub mode merges into ${base}; the working tree is on ${current}`);
  });
}

export interface OpenedArtifactPr {
  changeId: string;
  artifact: ArtifactIndex;
  branch: string;
  number: number;
  url: string;
}

/**
 * Every unmerged `sdlc/<CHG>/<artifact>` branch becomes a pull request: push,
 * open (or find) the PR, record `pr.opened{artifact}` on the branch, push
 * again. Idempotent: a branch whose PR is already recorded is skipped.
 */
export async function openArtifactPrs(mode: GitHubMode, store: StateStore): Promise<{ opened: OpenedArtifactPr[]; errors: string[] }> {
  const snap = await store.refresh();
  const repo = store.currentRepo;
  if (!repo) return { opened: [], errors: ["repository not loaded"] };
  const base = repo.config.defaultBranch;
  const opened: OpenedArtifactPr[] = [];
  const errors: string[] = [];
  const repoGh = await mode.host.repoFor(store.root);
  for (const b of snap.branches ?? []) {
    const index = ({ intent: 0, spec: 1, plan: 2, incident: 5 } as const)[b.artifact];
    let view: ChangeView;
    try {
      view = viewFor(repo, b.changeId);
    } catch {
      continue;
    }
    const recorded = view.artifactPrs[index];
    if (recorded && !recorded.merged && recorded.branch === b.branch) continue;
    try {
      await assertProtected(mode.host.client, repoGh, base);
      await pushBranch(store.root, b.branch);
      const doc = view.docs[index];
      const pull = (await findOpenPull(mode.host.client, repoGh, b.branch)) ?? (await openPull(mode.host.client, repoGh, {
        head: b.branch,
        base,
        title: `sdlc(${view.id}): ${doc.name} for review (gate ${stageDef((index + 1) as 1 | 2 | 3 | 6).gate ?? ""})`,
        body: [`${view.id} · ${view.title}`, "", `Artifact: ${doc.path}`, `Merging this PR is the gate decision; the console records it as gate.accepted{source: pr.merge}.`].join("\n"),
      }));
      const r = recordArtifactPr(repo, view, index, { number: pull.number, url: pull.url, branch: b.branch, headSha: b.head }, context(mode, mode.identity));
      if (!r.ok) throw refused(r);
      await commitOnBranch(store.root, b.branch, r.plan, { id: "sdlc-bot@sdlc.local", name: "sdlc-bot" });
      await pushBranch(store.root, b.branch);
      opened.push({ changeId: view.id, artifact: index, branch: b.branch, number: pull.number, url: pull.url });
      mode.log?.(`${view.id}: ${doc.name} in review as PR #${pull.number}`);
    } catch (e) {
      errors.push(`${b.branch}: ${(e as Error).message}`);
      mode.log?.(`${b.branch}: ${(e as Error).message}`);
    }
  }
  if (opened.length > 0) await store.refresh(true);
  return { opened, errors };
}

/** True when the gate's artifact sits on an unmerged branch with an open PR — the GitHub-mode path applies. */
export function artifactPrFor(view: ChangeView, gate: GateNumber, branches?: readonly { branch: string }[]): { index: ArtifactIndex; pr: NonNullable<ChangeView["artifactPrs"][ArtifactIndex]> } | null {
  if (gate === 5) return null;
  const index = ARTIFACT_INDEX_FOR_GATE[gate];
  const pr = view.artifactPrs[index];
  if (!pr || pr.merged) return null;
  // a branch already merged into the base (PR merged on GitHub, decision not yet recorded) is handled on the base branch
  if (branches && !branches.some((b) => b.branch === pr.branch)) return null;
  return { index, pr };
}

/**
 * Accept a gate whose artifact is a pull request: the decision is committed on
 * the PR branch, pushed, and the PR merged through the API with the branch head
 * as precondition — branch protection has the last word. Then the local base
 * branch takes origin's merge.
 */
export async function acceptViaPr(mode: GitHubMode, store: StateStore, id: string, gate: GateNumber): Promise<{ commit: string; mergeSha: string; number: number }> {
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const base = repo.config.defaultBranch;
  const view = viewFor(repo, id);
  const target = artifactPrFor(view, gate, store.current?.branches);
  if (!target) throw new ActionError(409, `${id}: no open pull request carries the artifact for gate ${gate}; the engine opens one for sdlc/${id}/<artifact> on its next pass (or run sdlc sync)`);
  await requireOnBase(store.root, base);
  const result = accept(repo, view, gate, context(mode, mode.identity, { source: "pr.merge" }));
  if (!result.ok) throw refused(result);
  const report = validateWritePlan(repo, result.plan);
  if (report.blocking) throw new ActionError(409, "write-plan rejected by validation", report.diagnostics.filter((d) => d.blocking));
  try {
    const repoGh = await mode.host.repoFor(store.root);
    await assertProtected(mode.host.client, repoGh, base);
    const commit = await commitOnBranch(store.root, target.pr.branch, result.plan, mode.identity);
    await pushBranch(store.root, target.pr.branch);
    const head = await headSha(store.root, target.pr.branch);
    const merged = await mergePull(mode.host.client, repoGh, target.pr.number, { sha: head, method: "merge", title: `sdlc(${id}): accept ${view.docs[target.index].name} (gate ${gate})` });
    if (!merged.merged) throw new CodeHostError(`GitHub did not merge #${target.pr.number}: ${merged.message}`, true);
    await mergeRemoteBranch(store.root, base, `sdlc(${id}): sync origin/${base} after #${target.pr.number}`, mode.identity);
    await store.refresh(true);
    return { commit, mergeSha: merged.sha, number: target.pr.number };
  } catch (e) {
    throw hostError(e);
  }
}

/** Send back through the PR: `gate.sent_back` on the branch plus a "request changes" review carrying the feedback. */
export async function sendBackViaPr(mode: GitHubMode, store: StateStore, id: string, gate: GateNumber, feedback: string): Promise<{ commit: string; number: number }> {
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const view = viewFor(repo, id);
  const target = artifactPrFor(view, gate, store.current?.branches);
  if (!target) throw new ActionError(409, `${id}: no open pull request carries the artifact for gate ${gate}`);
  const result = sendBack(repo, view, gate, feedback, context(mode, mode.identity, { source: "console" }));
  if (!result.ok) throw refused(result);
  try {
    const repoGh = await mode.host.repoFor(store.root);
    const commit = await commitOnBranch(store.root, target.pr.branch, result.plan, mode.identity);
    await pushBranch(store.root, target.pr.branch);
    await requestChanges(mode.host.client, repoGh, target.pr.number, feedback.trim());
    await store.refresh(true);
    return { commit, number: target.pr.number };
  } catch (e) {
    throw hostError(e);
  }
}

export interface DetectedMerge {
  changeId: string;
  gate: GateNumber;
  number: number;
  mergedBy: string;
  recorded: boolean;
  reason?: string;
}

/**
 * Pull requests merged on GitHub itself (a tech lead merging the plan PR, an
 * engineer merging the code PR): bring origin's base in, then record the gate
 * decision under the identity mapped to the merger's login. An unmapped login
 * is recorded as `<login>@users.noreply.github.com` and the gate-ownership
 * rule keeps the change out of the queues until config maps it.
 */
export async function detectMergedPrs(mode: GitHubMode, store: StateStore): Promise<DetectedMerge[]> {
  await store.refresh();
  let repo = store.currentRepo;
  if (!repo) return [];
  const base = repo.config.defaultBranch;
  const repoGh = await mode.host.repoFor(store.root);
  const candidates: { id: string; gate: GateNumber; number: number; mergeSha?: string }[] = [];
  for (const files of repo.changes.values()) {
    const view = deriveChange(repo, files);
    for (const [k, pr] of Object.entries(view.artifactPrs)) {
      const gate = ({ 0: 1, 1: 2, 2: 3, 5: 6 } as Record<string, GateNumber | undefined>)[k];
      if (pr && !pr.merged && gate) candidates.push({ id: view.id, gate, number: pr.number });
    }
    if (view.pr?.provider === "github" && view.pr.number !== undefined && !view.pr.mergeSha) candidates.push({ id: view.id, gate: 5, number: view.pr.number });
  }
  const out: DetectedMerge[] = [];
  let synced = false;
  for (const c of candidates) {
    let pull;
    try {
      pull = await getPull(mode.host.client, repoGh, c.number);
    } catch (e) {
      mode.log?.(`${c.id}: PR #${c.number}: ${(e as Error).message}`);
      continue;
    }
    if (!pull.merged) continue;
    if (!synced) {
      await requireOnBase(store.root, base);
      await mergeRemoteBranch(store.root, base, `sdlc: sync origin/${base}`, mode.identity);
      synced = true;
      await store.refresh(true);
      repo = store.currentRepo;
      if (!repo) return out;
    }
    const view = viewFor(repo, c.id);
    if (view.acceptedGates.includes(c.gate)) {
      out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: pull.mergedBy ?? "", recorded: false, reason: "already recorded" });
      continue;
    }
    const login = pull.mergedBy ?? "unknown";
    const mapped = identityForGitHubLogin(repo.config, login);
    const actor: GitIdentity = mapped ? { id: mapped.id, name: mapped.name ?? mapped.id } : { id: `${login}@users.noreply.github.com`, name: login };
    const result = accept(repo, view, c.gate, context(mode, actor, { source: "pr.merge", ...(c.gate === 5 && pull.mergeSha ? { mergeSha: pull.mergeSha } : {}) }));
    if (!result.ok) {
      out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: login, recorded: false, reason: result.diagnostics.map((d) => d.message).join("; ") });
      mode.log?.(`${c.id}: PR #${c.number} merged on GitHub by ${login} but not recorded: ${result.diagnostics.map((d) => d.message).join("; ")}`);
      continue;
    }
    const report = validateWritePlan(repo, result.plan);
    if (report.blocking) {
      out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: login, recorded: false, reason: report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ") });
      continue;
    }
    await commitWritePlan(store.root, result.plan, { identity: actor });
    await store.refresh(true);
    repo = store.currentRepo ?? repo;
    out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: login, recorded: true });
    mode.log?.(`${c.id}: gate ${c.gate} recorded from PR #${c.number} merged by ${login}`);
  }
  return out;
}

export const RECORDS_BRANCH = "sdlc/records";

export interface RecordsSync {
  ahead: number;
  pushed: boolean;
  number?: number;
  url?: string;
  error?: string;
}

/**
 * The console's lifecycle commits live on its local default branch, which
 * branch protection keeps it from pushing. They reach origin through one
 * long-lived `sdlc/records` PR that the console keeps current and a human merges.
 */
export async function syncRecords(mode: GitHubMode, store: StateStore): Promise<RecordsSync> {
  const repo = store.currentRepo ?? (await store.refresh(), store.currentRepo);
  if (!repo) return { ahead: 0, pushed: false, error: "repository not loaded" };
  const base = repo.config.defaultBranch;
  try {
    await fetchRemote(store.root, "origin", base);
    const behind = await gitRaw(store.root, ["rev-list", "--count", `${base}..origin/${base}`]);
    if (behind.code === 0 && Number(behind.stdout.trim()) > 0) {
      // origin moved (a merged records PR, a merge done on GitHub): take it before pushing
      await requireOnBase(store.root, base);
      await mergeRemoteBranch(store.root, base, `sdlc: sync origin/${base}`, mode.identity);
      await store.refresh(true);
    }
    const count = await gitRaw(store.root, ["rev-list", "--count", `origin/${base}..${base}`]);
    const ahead = count.code === 0 ? Number(count.stdout.trim()) : 0;
    if (ahead === 0) return { ahead, pushed: false };
    await git(store.root, ["push", "--quiet", "origin", `refs/heads/${base}:refs/heads/${RECORDS_BRANCH}`]);
    const repoGh = await mode.host.repoFor(store.root);
    const pull = (await findOpenPull(mode.host.client, repoGh, RECORDS_BRANCH)) ?? (await openPull(mode.host.client, repoGh, {
      head: RECORDS_BRANCH,
      base,
      title: "sdlc: lifecycle records",
      body: "Lifecycle records the console committed on its local default branch: ledger events, per-change runs, pr.yaml mirrors, cycle archives. Nothing here changes code. Merge to bring origin up to date; the console keeps this PR current.",
    }));
    return { ahead, pushed: true, number: pull.number, url: pull.url };
  } catch (e) {
    mode.log?.(`records sync: ${(e as Error).message}`);
    return { ahead: -1, pushed: false, error: (e as Error).message };
  }
}

export interface SyncSummary {
  opened: OpenedArtifactPr[];
  merges: DetectedMerge[];
  records: RecordsSync;
  errors: string[];
}

/** One GitHub-mode pass: artifact PRs, merges done on GitHub, records PR. */
export async function syncGitHub(mode: GitHubMode, store: StateStore): Promise<SyncSummary> {
  const opened = await openArtifactPrs(mode, store);
  const merges = await detectMergedPrs(mode, store).catch((e: Error) => {
    opened.errors.push(`merge detection: ${e.message}`);
    return [] as DetectedMerge[];
  });
  const records = await syncRecords(mode, store);
  return { opened: opened.opened, merges, records, errors: opened.errors };
}

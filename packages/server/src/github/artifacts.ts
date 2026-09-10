import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, blobSha, CodeHostError, commitWritePlan, currentBranch, diffFiles, fastForwardBranch, fetchRemote, git, gitRaw, headSha, hostName, listWorktrees, mergeRemoteBranch, newUlid, prNoun, pushBranch, removeWorktree, type GitIdentity, type HostedCodeHost } from "@sdlc/adapter-git";
import { accept, ARTIFACT_INDEX_FOR_GATE, deriveChange, identityForHostLogin, logPath, recordArtifactPr, sendBack, stageDef, validateWritePlan, type ArtifactIndex, type ChangeView, type Repo, type TransitionContext, type TransitionResult, type WritePlan } from "@sdlc/core";
import type { GateNumber } from "@sdlc/schemas";
import { ActionError, StateStore } from "../store.js";

/**
 * Hosted mode (GitHub since 2.2, GitLab since 3.7): everything here speaks
 * the `HostedCodeHost` contract, never one host's API. "PR" in the names and
 * the ledger is the record's word for a pull request or a merge request.
 */
export interface HostedMode {
  host: HostedCodeHost;
  identity: GitIdentity;
  /** Under a GitHub App (3.2): the App's bot user commits on behalf of `identity` — author is the person, committer is the App. */
  committer?: GitIdentity;
  now?: () => Date;
  log?: (line: string) => void;
}

/** @deprecated name from 2.2; `HostedMode` since 3.7. */
export type GitHubMode = HostedMode;

const ROLE_RULES = /(not-owner|not-engineer|not-po|gate\.via)/;

function refused(result: Extract<TransitionResult, { ok: false }>): ActionError {
  const first = result.diagnostics[0];
  const status = first && ROLE_RULES.test(first.rule) ? 403 : first?.rule.endsWith(".missing") ? 404 : 409;
  return new ActionError(status, first?.message ?? "refused", result.diagnostics);
}

function hostError(e: unknown): ActionError {
  if (e instanceof ActionError) return e;
  const retryable = e instanceof CodeHostError ? e.retryable : true;
  return new ActionError(retryable ? 502 : 409, (e as Error).message, [], retryable);
}

function iso(mode: HostedMode): string {
  return (mode.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function context(mode: HostedMode, actor: GitIdentity, extra: Partial<TransitionContext> = {}): TransitionContext {
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
  mkdirSync(join(root, ".sdlc-state", "worktrees"), { recursive: true });
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

/** Commit a write-plan on an artifact branch (decision rides with the artifact into the merge). `committer` is the App's bot user in hosted App mode. */
export function commitOnBranch(root: string, branch: string, plan: WritePlan, identity: GitIdentity, committer?: GitIdentity): Promise<string> {
  return withBranchWorktree(root, branch, (dir) => commitWritePlan(dir, plan, { identity, ...(committer ? { committer } : {}) }));
}

function viewFor(repo: Repo, id: string): ChangeView {
  const files = repo.changes.get(id);
  if (!files) throw new ActionError(404, `${id} not found`);
  return deriveChange(repo, files);
}

/**
 * Bring `origin/<base>` into the local default branch after a merge done on the
 * host. With the root working tree on `base`, a merge in place (fast-forward,
 * else a merge commit under the acting identity). With the root elsewhere — a
 * task branch checked out in the project root — the ref is fast-forwarded
 * without a checkout; when git refuses that (local lifecycle commits origin
 * lacks, or `base` checked out in another worktree) the merge runs in the
 * worktree that has `base`, or a temporary one. Never a force-update: local
 * commits are merged, not discarded.
 */
export async function syncBase(mode: HostedMode, root: string, base: string, message: string): Promise<string> {
  const merge = (dir: string) => mergeRemoteBranch(dir, base, message, mode.identity, "origin", mode.committer);
  if ((await currentBranch(root)) === base) return merge(root);
  const ff = await fastForwardBranch(root, base);
  if (ff.ok) return ff.head;
  mode.log?.(`${base} is not checked out here and does not fast-forward (${ff.reason}); merging in a worktree`);
  return withBranchWorktree(root, base, merge);
}

export interface OpenedArtifactPr {
  changeId: string;
  artifact: ArtifactIndex;
  branch: string;
  number: number;
  url: string;
}

export interface PushedArtifactBranch {
  changeId: string;
  artifact: ArtifactIndex;
  branch: string;
  number: number;
  head: string;
}

/**
 * Every unmerged `sdlc/<CHG>/<artifact>` branch that carries its artifact
 * becomes a pull request (merge request on GitLab): push, open (or find) it,
 * record `pr.opened{artifact}` on the branch, push again. A branch with
 * ledger lines only (a session started, or failed, before proposing) is not
 * in review yet and opens nothing. Idempotent: a branch whose PR is already
 * recorded is pushed again only when its head moved past origin's — the
 * agent's revisions reach the PR the reviewer reads — and never reopened. A
 * branch that differs from the base by ledger lines only is dropped: nothing
 * to review.
 */
export async function openArtifactPrs(mode: HostedMode, store: StateStore): Promise<{ opened: OpenedArtifactPr[]; pushed: PushedArtifactBranch[]; errors: string[] }> {
  const snap = await store.refresh();
  const repo = store.currentRepo;
  if (!repo) return { opened: [], pushed: [], errors: ["repository not loaded"] };
  const base = repo.config.defaultBranch;
  const opened: OpenedArtifactPr[] = [];
  const pushed: PushedArtifactBranch[] = [];
  const errors: string[] = [];
  const noun = prNoun(mode.host.provider);
  for (const b of snap.branches ?? []) {
    const index = ({ intent: 0, spec: 1, plan: 2, incident: 5 } as const)[b.artifact];
    let view: ChangeView;
    try {
      view = viewFor(repo, b.changeId);
    } catch {
      continue;
    }
    const doc = view.docs[index];
    const recorded = view.artifactPrs[index];
    // a branch whose only commits past the base are ledger lines carries nothing to review: its PR merged before the
    // console's own `pr.opened` line was pushed (a human merging within seconds of the open), so the artifact is already
    // on main. The branch is dropped so it stops overlaying the change; only the console's own lines go with it.
    const touched = await diffFiles(store.root, `${base}...${b.branch}`).catch(() => null); // what the branch adds since it forked, not what main gained since
    if (touched && touched.every((path) => path === logPath(view.id))) {
      await gitRaw(store.root, ["branch", "-D", b.branch]);
      mode.log?.(`${b.branch}: only ledger lines past ${base}; nothing to review — branch dropped`);
      continue;
    }
    if (recorded && !recorded.merged && recorded.branch === b.branch) {
      const origin = await gitRaw(store.root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${b.branch}`]);
      if (origin.code === 0 && origin.stdout.trim() === b.head) continue;
      try {
        await pushBranch(store.root, b.branch);
        pushed.push({ changeId: view.id, artifact: index, branch: b.branch, number: recorded.number, head: b.head });
        mode.log?.(`${view.id}: ${doc.name} revised · ${mode.host.label(recorded.number)} updated`);
      } catch (e) {
        errors.push(`${b.branch}: ${(e as Error).message}`);
        mode.log?.(`${b.branch}: ${(e as Error).message}`);
      }
      continue;
    }
    if (doc.state === "absent") continue;
    try {
      await mode.host.assertProtected(store.root, base);
      await pushBranch(store.root, b.branch);
      const pull = (await mode.host.findOpenPr(store.root, b.branch)) ?? (await mode.host.openHostedPr(store.root, {
        head: b.branch,
        base,
        title: `sdlc(${view.id}): ${doc.name} for review (gate ${stageDef((index + 1) as 1 | 2 | 3 | 6).gate ?? ""})`,
        body: [`${view.id} · ${view.title}`, "", `Artifact: ${doc.path}`, `Merging this ${noun} is the gate decision; the console records it as gate.accepted{source: pr.merge}.`].join("\n"),
      }));
      const r = recordArtifactPr(repo, view, index, { number: pull.number, url: pull.url, branch: b.branch, headSha: b.head }, context(mode, mode.identity));
      if (!r.ok) throw refused(r);
      await commitOnBranch(store.root, b.branch, r.plan, { id: "sdlc-bot@sdlc.local", name: "sdlc-bot" });
      await pushBranch(store.root, b.branch);
      opened.push({ changeId: view.id, artifact: index, branch: b.branch, number: pull.number, url: pull.url });
      mode.log?.(`${view.id}: ${doc.name} in review as ${mode.host.label(pull.number)}`);
    } catch (e) {
      errors.push(`${b.branch}: ${(e as Error).message}`);
      mode.log?.(`${b.branch}: ${(e as Error).message}`);
    }
  }
  if (opened.length > 0) await store.refresh(true);
  return { opened, pushed, errors };
}

/** True when the gate's artifact sits on an unmerged branch with an open PR — the hosted-mode path applies. */
export function artifactPrFor(view: ChangeView, gate: GateNumber, branches?: readonly { branch: string }[]): { index: ArtifactIndex; pr: NonNullable<ChangeView["artifactPrs"][ArtifactIndex]> } | null {
  if (gate === 5) return null;
  const index = ARTIFACT_INDEX_FOR_GATE[gate];
  const pr = view.artifactPrs[index];
  if (!pr || pr.merged) return null;
  // a branch already merged into the base (PR merged on the host, decision not yet recorded) is handled on the base branch
  if (branches && !branches.some((b) => b.branch === pr.branch)) return null;
  return { index, pr };
}

/**
 * Accept a gate whose artifact is a pull request: the decision is committed on
 * the PR branch, pushed, and the PR merged through the API with the branch head
 * as precondition — branch protection has the last word. Then the local base
 * branch takes origin's merge.
 */
export async function acceptViaPr(mode: HostedMode, store: StateStore, id: string, gate: GateNumber): Promise<{ commit: string; mergeSha: string; number: number }> {
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const base = repo.config.defaultBranch;
  const view = viewFor(repo, id);
  const target = artifactPrFor(view, gate, store.current?.branches);
  if (!target) throw new ActionError(409, `${id}: no open ${prNoun(mode.host.provider)} carries the artifact for gate ${gate}; the engine opens one for sdlc/${id}/<artifact> on its next pass (or run sdlc sync)`);
  const result = accept(repo, view, gate, context(mode, mode.identity, { source: "pr.merge" }));
  if (!result.ok) throw refused(result);
  const report = validateWritePlan(repo, result.plan);
  if (report.blocking) throw new ActionError(409, "write-plan rejected by validation", report.diagnostics.filter((d) => d.blocking));
  try {
    await mode.host.assertProtected(store.root, base);
    const commit = await commitOnBranch(store.root, target.pr.branch, result.plan, mode.identity, mode.committer);
    await pushBranch(store.root, target.pr.branch);
    const head = await headSha(store.root, target.pr.branch);
    const label = mode.host.label(target.pr.number);
    const merged = await mode.host.mergeHostedPr(store.root, target.pr.number, { sha: head, title: `sdlc(${id}): accept ${view.docs[target.index].name} (gate ${gate})` });
    if (!merged.merged) throw new CodeHostError(`${hostName(mode.host.provider)} did not merge ${label}: ${merged.message}`, true);
    await syncBase(mode, store.root, base, `sdlc(${id}): sync origin/${base} after ${label}`);
    await store.refresh(true);
    return { commit, mergeSha: merged.sha, number: target.pr.number };
  } catch (e) {
    throw hostError(e);
  }
}

/** Send back through the PR: `gate.sent_back` on the branch plus the host's "request changes" (a review on GitHub, a note on GitLab) carrying the feedback. */
export async function sendBackViaPr(mode: HostedMode, store: StateStore, id: string, gate: GateNumber, feedback: string): Promise<{ commit: string; number: number }> {
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const view = viewFor(repo, id);
  const target = artifactPrFor(view, gate, store.current?.branches);
  if (!target) throw new ActionError(409, `${id}: no open ${prNoun(mode.host.provider)} carries the artifact for gate ${gate}`);
  const result = sendBack(repo, view, gate, feedback, context(mode, mode.identity, { source: "console" }));
  if (!result.ok) throw refused(result);
  try {
    const commit = await commitOnBranch(store.root, target.pr.branch, result.plan, mode.identity, mode.committer);
    await pushBranch(store.root, target.pr.branch);
    await mode.host.requestChanges(store.root, target.pr.number, feedback.trim());
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
 * Pull requests merged on the host itself (a tech lead merging the plan PR,
 * an engineer merging the code PR): bring origin's base in, then record the
 * gate decision under the identity mapped to the merger's login (the
 * `github` / `gitlab` field on config identities). An unmapped login is
 * recorded under the host's no-reply address and the gate-ownership rule
 * keeps the change out of the queues until config maps it.
 */
export async function detectMergedPrs(mode: HostedMode, store: StateStore): Promise<DetectedMerge[]> {
  await store.refresh();
  let repo = store.currentRepo;
  if (!repo) return [];
  const base = repo.config.defaultBranch;
  const candidates: { id: string; gate: GateNumber; number: number; mergeSha?: string }[] = [];
  for (const files of repo.changes.values()) {
    const view = deriveChange(repo, files);
    for (const [k, pr] of Object.entries(view.artifactPrs)) {
      const gate = ({ 0: 1, 1: 2, 2: 3, 5: 6 } as Record<string, GateNumber | undefined>)[k];
      if (pr && !pr.merged && gate) candidates.push({ id: view.id, gate, number: pr.number });
    }
    if (view.pr && view.pr.provider === mode.host.provider && view.pr.number !== undefined && !view.pr.mergeSha) candidates.push({ id: view.id, gate: 5, number: view.pr.number });
  }
  const out: DetectedMerge[] = [];
  let synced = false;
  for (const c of candidates) {
    const label = mode.host.label(c.number);
    let pull;
    try {
      pull = await mode.host.getHostedPr(store.root, c.number);
    } catch (e) {
      mode.log?.(`${c.id}: ${label}: ${(e as Error).message}`);
      continue;
    }
    if (!pull.merged) continue;
    if (!synced) {
      await syncBase(mode, store.root, base, `sdlc: sync origin/${base}`);
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
    const mapped = identityForHostLogin(repo.config, mode.host.loginField, login);
    const actor: GitIdentity = mapped ? { id: mapped.id, name: mapped.name ?? mapped.id } : { id: mode.host.noreplyAddress(login), name: login };
    const result = accept(repo, view, c.gate, context(mode, actor, { source: "pr.merge", ...(c.gate === 5 && pull.mergeSha ? { mergeSha: pull.mergeSha } : {}) }));
    if (!result.ok) {
      out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: login, recorded: false, reason: result.diagnostics.map((d) => d.message).join("; ") });
      mode.log?.(`${c.id}: ${label} merged on ${hostName(mode.host.provider)} by ${login} but not recorded: ${result.diagnostics.map((d) => d.message).join("; ")}`);
      continue;
    }
    const report = validateWritePlan(repo, result.plan);
    if (report.blocking) {
      out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: login, recorded: false, reason: report.diagnostics.filter((d) => d.blocking).map((d) => d.message).join("; ") });
      continue;
    }
    await commitWritePlan(store.root, result.plan, { identity: actor, ...(mode.committer ? { committer: mode.committer } : {}) });
    await store.refresh(true);
    repo = store.currentRepo ?? repo;
    out.push({ changeId: c.id, gate: c.gate, number: c.number, mergedBy: login, recorded: true });
    mode.log?.(`${c.id}: gate ${c.gate} recorded from ${label} merged by ${login}`);
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
export async function syncRecords(mode: HostedMode, store: StateStore): Promise<RecordsSync> {
  const repo = store.currentRepo ?? (await store.refresh(), store.currentRepo);
  if (!repo) return { ahead: 0, pushed: false, error: "repository not loaded" };
  const base = repo.config.defaultBranch;
  try {
    await fetchRemote(store.root, "origin", base);
    const behind = await gitRaw(store.root, ["rev-list", "--count", `${base}..origin/${base}`]);
    if (behind.code === 0 && Number(behind.stdout.trim()) > 0) {
      // origin moved (a merged records PR, a merge done on the host): take it before pushing
      await syncBase(mode, store.root, base, `sdlc: sync origin/${base}`);
      await store.refresh(true);
    }
    const count = await gitRaw(store.root, ["rev-list", "--count", `origin/${base}..${base}`]);
    const ahead = count.code === 0 ? Number(count.stdout.trim()) : 0;
    if (ahead === 0) return { ahead, pushed: false };
    await git(store.root, ["push", "--quiet", "origin", `refs/heads/${base}:refs/heads/${RECORDS_BRANCH}`]);
    const pull = (await mode.host.findOpenPr(store.root, RECORDS_BRANCH)) ?? (await mode.host.openHostedPr(store.root, {
      head: RECORDS_BRANCH,
      base,
      title: "sdlc: lifecycle records",
      body: `Lifecycle records the console committed on its local default branch: ledger events, per-change runs, pr.yaml mirrors, cycle archives. Nothing here changes code. Merge to bring origin up to date; the console keeps this ${prNoun(mode.host.provider)} current.`,
    }));
    return { ahead, pushed: true, number: pull.number, url: pull.url };
  } catch (e) {
    mode.log?.(`records sync: ${(e as Error).message}`);
    return { ahead: -1, pushed: false, error: (e as Error).message };
  }
}

export interface SyncSummary {
  opened: OpenedArtifactPr[];
  /** Open artifact PRs whose branch was pushed again because the local head moved. */
  pushed: PushedArtifactBranch[];
  merges: DetectedMerge[];
  records: RecordsSync;
  errors: string[];
}

/**
 * One hosted-mode pass: merges done on the host first (so a branch merged
 * there is off the list before anything tries to open a PR for it), then
 * artifact PRs, then the records PR.
 */
export async function syncCodeHost(mode: HostedMode, store: StateStore): Promise<SyncSummary> {
  const errors: string[] = [];
  const merges = await detectMergedPrs(mode, store).catch((e: Error) => {
    errors.push(`merge detection: ${e.message}`);
    return [] as DetectedMerge[];
  });
  const opened = await openArtifactPrs(mode, store);
  const records = await syncRecords(mode, store);
  return { opened: opened.opened, pushed: opened.pushed, merges, records, errors: [...errors, ...opened.errors] };
}

/** @deprecated name from 2.2; `syncCodeHost` since 3.7 (the pass is the same on GitLab). */
export const syncGitHub = syncCodeHost;

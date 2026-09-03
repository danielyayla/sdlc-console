import { CodeHostError, git, mergeIfUnmerged } from "@sdlc/adapter-git";
import { codeHostFor } from "./engine/codehost.js";
import { acceptViaPr, artifactPrFor, sendBackViaPr } from "./github/artifacts.js";
import type { GitHubCodeHost } from "@sdlc/adapter-github";
import {
  accept,
  acceptTriage,
  confirmRepro,
  confirmTasks,
  dismissAutoFinding,
  liftFreeze,
  rejectRepro,
  createChange,
  deriveChange,
  dismissFinding,
  dismissProposal,
  dismissTriage,
  escalateFinding,
  harvestCase,
  importFindings,
  loop,
  patchFinding,
  proposeTasks,
  sendBack,
  stageDef,
  type ChangeView,
  type CreateChangeInput,
  type ReproInput,
  type Repo,
  type TaskInput,
} from "@sdlc/core";
import { parseFindingsImport, type GateNumber } from "@sdlc/schemas";
import { ActionError, type StateStore } from "./store.js";
import type { Snapshot } from "./snapshot.js";

export interface ActionResult {
  commit: string;
  snapshot: Snapshot;
  /** Toast text; the server decides so the text matches the real outcome (§10). */
  toast: string;
  changeId: string | null;
}

function view(repo: Repo, id: string): ChangeView {
  const files = repo.changes.get(id);
  if (!files) throw new ActionError(404, `${id} not found`);
  return deriveChange(repo, files);
}

export async function acceptGate(store: StateStore, id: string, gate: GateNumber, env: Record<string, string | undefined> = process.env): Promise<ActionResult> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const before = view(repo, id);
  let mergeSha: string | undefined;
  let source: "console" | "pr.merge" = "console";
  if (gate === 5) {
    if (!before.gate || before.gate.s !== 5 || !before.pr) throw new ActionError(409, `${id} is not waiting at gate 5 (${before.status})`);
    // spec 5B.3: the console merges nothing while a system-raised finding stands or a fix's repro proof is red — checked before the branch moves, so a refusal leaves nothing half-done
    const open = (before.pr.autoFindings ?? []).filter((f) => !f.dismissal);
    if (open.length > 0) throw new ActionError(409, `${open.length} auto-finding${open.length === 1 ? "" : "s"} block${open.length === 1 ? "s" : ""} the merge (${open.map((f) => `${f.title}: ${f.path}`).join("; ")}) — dismiss with a reason first`, open.map((f) => ({ path: `sdlc/changes/${id}/pr.yaml`, severity: "error" as const, rule: "merge.auto-finding", message: `${f.title}: ${f.path}` })));
    const reproCheck = before.pr.checks.find((c) => c.name === "repro");
    if (before.kind === "fix" && reproCheck && reproCheck.verdict !== "pass") throw new ActionError(409, `the repro proof is ${reproCheck.verdict}${reproCheck.summary ? ` (${reproCheck.summary})` : ""} — a fix merges only with its repro test committed before the fix, unchanged and passing`, [{ path: `sdlc/changes/${id}/pr.yaml`, severity: "error", rule: "merge.repro-red", message: reproCheck.summary ?? "repro check failed" }]);
    const root = store.root;
    const base = repo.config.defaultBranch;
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== base) throw new ActionError(409, `gate 5 merges into ${base}; the working tree is on ${current}`);
    try {
      const host = codeHostFor(repo.config.codeHost, env);
      mergeSha = await host.merge(root, before.pr, `sdlc(${id}): merge ${before.pr.branch} (gate 5)`, store.who);
      if (host.provider === "github") source = "pr.merge";
    } catch (e) {
      const retryable = e instanceof CodeHostError ? e.retryable : true;
      throw new ActionError(retryable ? 502 : 409, `merge refused: ${(e as Error).message}`, [], retryable);
    }
  }
  if (gate !== 5 && repo.config.codeHost === "github" && artifactPrFor(before, gate, store.current?.branches)) {
    // GitHub mode: the artifact is a pull request; accepting is merging it
    const host = codeHostFor("github", env) as GitHubCodeHost;
    const r = await acceptViaPr({ host, identity: store.who }, store, id, gate);
    const snap = store.current ?? (await store.refresh());
    const after = snap.changes.find((c) => c.id === id);
    const toast = gate === 6 ? `Loop closed — ${id} re-entered Plan` : `${before.gate?.label ?? `gate ${gate}`} — ${id} moved to ${after ? stageDef(after.stage).name : "next stage"} (PR #${r.number} merged)`;
    return { commit: r.commit, snapshot: snap, toast, changeId: id };
  }
  if (gate !== 5) {
    // local mode: a draft on sdlc/<CHG>/<artifact> reaches the default branch when the owner accepts
    const artifact = { 1: "intent", 2: "spec", 3: "plan", 6: "incident" }[gate];
    const current = (await git(store.root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === repo.config.defaultBranch) {
      try {
        await mergeIfUnmerged(store.root, `sdlc/${id}/${artifact}`, `sdlc(${id}): merge sdlc/${id}/${artifact} (gate ${gate})`, store.who);
      } catch (e) {
        throw new ActionError(502, `merge of sdlc/${id}/${artifact} refused: ${(e as Error).message}`, [], true);
      }
    }
  }
  const r = await store.act((repo2, ctx) => accept(repo2, view(repo2, id), gate, ctx), { source, ...(mergeSha ? { mergeSha } : {}) });
  const after = r.snapshot.changes.find((c) => c.id === id);
  const label = before.gate?.label ?? `gate ${gate}`;
  const toast = gate === 6 ? `Loop closed — ${id} re-entered Plan` : `${label} — ${id} moved to ${after ? stageDef(after.stage).name : "next stage"}`;
  return { ...r, toast, changeId: id };
}

export async function sendBackGate(store: StateStore, id: string, gate: GateNumber, feedback: string, env: Record<string, string | undefined> = process.env): Promise<ActionResult> {
  await store.refresh();
  const repo0 = store.currentRepo;
  if (repo0 && gate !== 5 && repo0.config.codeHost === "github" && artifactPrFor(view(repo0, id), gate, store.current?.branches)) {
    const host = codeHostFor("github", env) as GitHubCodeHost;
    const r = await sendBackViaPr({ host, identity: store.who }, store, id, gate, feedback);
    const snap = store.current ?? (await store.refresh());
    const after = snap.changes.find((c) => c.id === id);
    return { commit: r.commit, snapshot: snap, toast: `${after ? stageDef(after.stage).file : "artifact"} sent back on PR #${r.number} — ${id} stays in ${after ? stageDef(after.stage).name : "stage"}`, changeId: id };
  }
  const r = await store.act((repo, ctx) => sendBack(repo, view(repo, id), gate, feedback, { ...ctx, source: "console" }));
  const after = r.snapshot.changes.find((c) => c.id === id);
  return { ...r, toast: `${after ? stageDef(after.stage).file : "artifact"} sent back — ${id} stays in ${after ? stageDef(after.stage).name : "stage"}`, changeId: id };
}

export async function loopChange(store: StateStore, id: string): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => loop(repo, view(repo, id), ctx));
  return { ...r, toast: `Loop closed — ${id} re-entered Plan`, changeId: id };
}

export async function newChange(store: StateStore, input: CreateChangeInput): Promise<ActionResult> {
  let created: string | null = null;
  const r = await store.act((repo, ctx) => {
    const res = createChange(repo, input, ctx);
    if (res.ok) created = res.plan.changeId;
    return res;
  });
  return { ...r, toast: `${created ?? "change"} created — waiting at the Plan gate`, changeId: created };
}

export async function confirmTaskSplit(store: StateStore, id: string, tasks: TaskInput[] | undefined): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => {
    const v = view(repo, id);
    const input = tasks && tasks.length > 0 ? tasks : proposeTasks(v.planFiles, v.acceptanceLine);
    return confirmTasks(repo, v, input, ctx);
  });
  const after = r.snapshot.changes.find((c) => c.id === id);
  return { ...r, toast: `${after?.tasks.length ?? 0} task${after?.tasks.length === 1 ? "" : "s"} confirmed for ${id}`, changeId: id };
}

export async function confirmReproTest(store: StateStore, id: string, input: ReproInput): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => confirmRepro(repo, view(repo, id), input, ctx));
  return { ...r, toast: `Repro test committed — freeze active on ${id}`, changeId: id };
}

/** "Wrong failure — send back": the engineer's verdict goes on the ledger; the session is resumed with it by the caller. */
export async function rejectReproTest(store: StateStore, id: string, input: { testPath: string; reason: string }): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => rejectRepro(repo, view(repo, id), input, ctx));
  return { ...r, toast: `Repro test sent back on ${id} — ${input.reason}`, changeId: id };
}

/** Freeze lift, once per file per change (FR-22). */
export async function liftTestFreeze(store: StateStore, id: string, input: { path: string; reason: string }): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => liftFreeze(repo, view(repo, id), input, ctx));
  return { ...r, toast: `Test freeze lifted once for ${input.path} on ${id}`, changeId: id };
}

/** Dismiss a system-raised PR finding with a reason; the console's merge unblocks. */
export async function dismissPrAutoFinding(store: StateStore, id: string, input: { path: string; reason: string }): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => dismissAutoFinding(repo, view(repo, id), input, ctx));
  return { ...r, toast: `Auto-finding on ${input.path} dismissed — ${input.reason}`, changeId: id };
}

export async function triageAccept(store: StateStore, triageId: string): Promise<ActionResult> {
  let created: string | null = null;
  const r = await store.act((repo, ctx) => {
    const res = acceptTriage(repo, triageId, ctx);
    if (res.ok) created = res.plan.changeId;
    return res;
  });
  return { ...r, toast: `${created ?? "change"} created — waiting at the Plan gate`, changeId: created };
}

export async function triageDismiss(store: StateStore, triageId: string, reason: string, bandTune?: string): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => dismissTriage(repo, triageId, reason, ctx, bandTune));
  return { ...r, toast: `${triageId} dismissed${bandTune ? " · band tuned" : ""}`, changeId: null };
}

export async function findingPatch(store: StateStore, findingId: string): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => patchFinding(repo, findingId, ctx));
  return { ...r, toast: `${findingId} → patch in PR gate · review gate decides`, changeId: null };
}

export async function findingEscalate(store: StateStore, findingId: string): Promise<ActionResult> {
  let created: string | null = null;
  const r = await store.act((repo, ctx) => {
    const res = escalateFinding(repo, findingId, ctx);
    if (res.ok) created = res.plan.changeId;
    return res;
  });
  return { ...r, toast: `${created ?? "change"} created from ${findingId} — waiting at the Plan gate`, changeId: created };
}

export async function findingDismiss(store: StateStore, findingId: string, reason: string): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => dismissFinding(repo, findingId, reason, ctx));
  return { ...r, toast: `${findingId} dismissed`, changeId: null };
}

export async function findingsImport(store: StateStore, text: string): Promise<ActionResult> {
  const parsed = parseFindingsImport(text, "import");
  if (!parsed.ok || !parsed.value) throw new ActionError(400, parsed.diagnostics[0]?.message ?? "nothing to import", parsed.diagnostics);
  const rows = parsed.value;
  const r = await store.act((repo, ctx) => importFindings(repo, rows, ctx));
  const created = r.snapshot.findings.length;
  return { ...r, toast: `imported ${rows.length} finding${rows.length === 1 ? "" : "s"} · ${created} on file`, changeId: null };
}

export async function proposalDismiss(store: StateStore, id: string, reason: string): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => dismissProposal(repo, id, reason, ctx));
  return { ...r, toast: `${id} dismissed`, changeId: null };
}

/** Post-merge "Add as eval": a draft case for the platform owner (FR-53). */
export async function harvestChange(store: StateStore, id: string): Promise<ActionResult> {
  let caseId: string | null = null;
  const r = await store.act((repo, ctx) => {
    const res = harvestCase(repo, view(repo, id), ctx);
    if (res.ok) caseId = res.caseId ?? null;
    return res;
  });
  return { ...r, toast: `${caseId ?? "case"} drafted from ${id} — the platform owner activates it under evals/cases`, changeId: id };
}

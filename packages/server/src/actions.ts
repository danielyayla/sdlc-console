import { git, mergeBranch, mergeIfUnmerged } from "@sdlc/adapter-git";
import {
  accept,
  acceptTriage,
  confirmRepro,
  confirmTasks,
  createChange,
  deriveChange,
  dismissFinding,
  dismissTriage,
  escalateFinding,
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

export async function acceptGate(store: StateStore, id: string, gate: GateNumber): Promise<ActionResult> {
  await store.refresh();
  const repo = store.currentRepo;
  if (!repo) throw new ActionError(502, "repository not loaded", [], true);
  const before = view(repo, id);
  let mergeSha: string | undefined;
  if (gate === 5) {
    if (!before.gate || before.gate.s !== 5 || !before.pr) throw new ActionError(409, `${id} is not waiting at gate 5 (${before.status})`);
    const root = store.root;
    const base = repo.config.defaultBranch;
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== base) throw new ActionError(409, `gate 5 merges into ${base}; the working tree is on ${current}`);
    try {
      mergeSha = await mergeBranch(root, before.pr.branch, `sdlc(${id}): merge ${before.pr.branch} (gate 5)`, store.who);
    } catch (e) {
      throw new ActionError(502, `merge refused: ${(e as Error).message}`, [], true);
    }
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
  const r = await store.act((repo2, ctx) => accept(repo2, view(repo2, id), gate, ctx), mergeSha ? { mergeSha } : {});
  const after = r.snapshot.changes.find((c) => c.id === id);
  const label = before.gate?.label ?? `gate ${gate}`;
  const toast = gate === 6 ? `Loop closed — ${id} re-entered Plan` : `${label} — ${id} moved to ${after ? stageDef(after.stage).name : "next stage"}`;
  return { ...r, toast, changeId: id };
}

export async function sendBackGate(store: StateStore, id: string, gate: GateNumber, feedback: string): Promise<ActionResult> {
  const r = await store.act((repo, ctx) => sendBack(repo, view(repo, id), gate, feedback, ctx));
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

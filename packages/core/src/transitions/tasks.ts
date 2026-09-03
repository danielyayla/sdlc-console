import { stringifyYaml, type Task, type Tasks } from "@sdlc/schemas";
import { holdsRole } from "../config.js";
import type { ChangeView } from "../derive.js";
import type { Repo } from "../repo.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { EventBuilder, trailersFor, type TransitionContext } from "./context.js";

export interface TaskInput {
  id?: string;
  title: string;
  files: string[];
  target?: string;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/** Propose one task per directory of the plan's file list; target prefilled from the acceptance line (FR-30). */
export function proposeTasks(planFiles: readonly string[], acceptanceLine: string | null): TaskInput[] {
  const groups = new Map<string, string[]>();
  for (const f of planFiles) {
    const d = dirOf(f);
    groups.set(d, [...(groups.get(d) ?? []), f]);
  }
  return [...groups.entries()].map(([dir, files]) => ({
    id: slugify(dir === "." ? "root" : dir),
    title: dir === "." ? "Root files" : `Work in ${dir}`,
    files,
    ...(acceptanceLine ? { target: acceptanceLine } : {}),
  }));
}

/** Tasks sharing a file are merged into one sequential task ("sequential · shared files"). */
export function mergeOverlaps(tasks: readonly TaskInput[]): (TaskInput & { id: string; sequential: boolean })[] {
  const parent = tasks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] ?? i)));
  const owner = new Map<string, number>();
  tasks.forEach((t, i) => {
    for (const f of t.files) {
      const o = owner.get(f);
      if (o === undefined) owner.set(f, i);
      else parent[find(i)] = find(o);
    }
  });
  const groups = new Map<number, number[]>();
  tasks.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()].map((members) => {
    const parts = members.map((i) => tasks[i]).filter((t): t is TaskInput => t !== undefined);
    if (parts.length === 1 && parts[0]) {
      const t = parts[0];
      return { ...t, id: t.id ?? slugify(t.title), sequential: false };
    }
    const files = [...new Set(parts.flatMap((t) => t.files))];
    const shared = files.filter((f) => parts.filter((t) => t.files.includes(f)).length > 1);
    const target = parts.map((t) => t.target).find((x) => x);
    return {
      id: parts.map((t) => t.id ?? slugify(t.title)).join("+").slice(0, 60),
      title: `${parts.map((t) => t.title).join(" + ")} · sequential · shared files: ${shared.join(", ")}`,
      files,
      ...(target ? { target } : {}),
      sequential: true,
    };
  });
}

/** Engineer confirms the split; worktrees/branches named `<CHG>/<slug>` (docs/storage-layout.md). */
export function confirmTasks(repo: Repo, view: ChangeView, input: readonly TaskInput[], ctx: TransitionContext): TransitionResult {
  if (!repo.config.present) return refuse("config.missing", "sdlc/config.yaml is missing");
  if (!holdsRole(repo.config, ctx.actor.id, "eng")) return refuse("tasks.not-engineer", `${ctx.actor.id} does not hold the engineer role`);
  if (!view.valid) return refuse("change.invalid", `${view.id} has validation errors`);
  if (view.stage !== 4) return refuse("tasks.stage", `tasks are confirmed after plan.md is accepted (stage 4); ${view.id} is at stage ${view.stage}`);
  if (input.length === 0) return refuse("tasks.empty", "no tasks to confirm");
  for (const t of input) {
    if (t.title.trim() === "") return refuse("tasks.title.empty", "every task needs a title");
    if (t.files.length === 0) return refuse("tasks.files.empty", `task "${t.title}" lists no files`);
  }
  const files = repo.changes.get(view.id);
  if (!files?.change) return refuse("change.missing", `${view.id} not loaded`);
  const merged = mergeOverlaps(input);
  const tasks: Task[] = merged.map((t) => ({
    id: t.id,
    title: t.title,
    files: t.files,
    sequential: t.sequential,
    ...(t.target ? { target: t.target } : {}),
    worktree: `${view.id}/${t.id}`,
    branch: `${view.id}/${t.id}`,
    state: "confirmed",
  }));
  const doc: Tasks = { schema: 1, changeId: view.id, cycle: files.change.cycle, tasks };
  const ev = new EventBuilder(ctx, files, view.id);
  const event = ev.human("tasks.confirmed", "eng", files.change.cycle, { taskIds: tasks.map((t) => t.id) });
  const plan: WritePlan = {
    changeId: view.id,
    files: [{ path: `${files.dir}/tasks.yaml`, content: stringifyYaml(doc) }],
    events: [ev.write(event)],
    commitMessage: `sdlc(${view.id}): confirm ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
    trailers: trailersFor([event], ctx.actor),
    actor: { type: "human", id: ctx.actor.id, role: "eng" },
  };
  return { ok: true, plan };
}

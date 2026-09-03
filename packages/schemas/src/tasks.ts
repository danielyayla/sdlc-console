import { z } from "zod";
import { changeId, cycleNumber, nonEmpty, relPath, schemaVersion, taskId } from "./common.js";

export const taskState = z.enum(["proposed", "confirmed", "running", "done", "reviewed"]);

export const task = z.strictObject({
  id: taskId,
  title: nonEmpty,
  files: z.array(relPath),
  sequential: z.boolean(),
  target: z.string().optional(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  state: taskState,
});

/** `sdlc/changes/<id>/tasks.yaml`: the confirmed split of an accepted plan. */
export const tasks = z.strictObject({
  schema: schemaVersion,
  changeId,
  cycle: cycleNumber,
  tasks: z.array(task),
});

export type Task = z.infer<typeof task>;
export type Tasks = z.infer<typeof tasks>;
export type TaskState = z.infer<typeof taskState>;

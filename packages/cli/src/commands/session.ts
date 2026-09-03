import { fileURLToPath } from "node:url";
import { enrich, launchSession, SessionRegistry, stopSession, type LaunchInput, type StoredSession } from "@sdlc/server";
import { actingIdentity, assertHuman, loadCommitted, repoContext, type CliContext } from "../context.js";
import { CliError, type Io } from "../io.js";

export function sdlcBinPath(): string {
  return fileURLToPath(new URL("../bin.js", import.meta.url));
}

export interface SessionStartOptions extends Omit<LaunchInput, "changeId"> {
  /** Return before the harness exits. */
  detach?: boolean;
}

export interface SessionStartResult {
  session: StoredSession;
  exitCode: number | null;
}

/** `sdlc session start <CHG>`: launch and, unless --detach, wait for the harness to exit. */
export async function sessionStart(ctx: CliContext, changeId: string, opts: SessionStartOptions): Promise<SessionStartResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const registry = new SessionRegistry(ctx.root);
  try {
    const { detach, ...launch } = opts;
    const r = await launchSession({ changeId, ...launch }, { root: ctx.root, registry, sdlcBin: sdlcBinPath(), identity: who, env: ctx.io.env });
    if (r.session.mode === "SUPERVISED") {
      ctx.io.stderr(`session ${r.session.id} prepared; run:\n  ${r.session.command}\n`);
      return { session: r.session, exitCode: null };
    }
    if (detach) return { session: r.session, exitCode: null };
    ctx.io.stderr(`session ${r.session.id} running (${r.session.mode}) on ${r.session.branch} — transcript ${r.session.transcriptRef ?? ""}\n`);
    const code = await r.finished;
    const final = registry.get(r.session.id) ?? r.session;
    return { session: final, exitCode: code };
  } finally {
    registry.close();
  }
}

export async function sessionList(ctx: CliContext): Promise<StoredSession[]> {
  const registry = new SessionRegistry(ctx.root);
  try {
    const { repo } = await loadCommitted(ctx);
    return registry.list().map((s) => enrich(s, repo));
  } finally {
    registry.close();
  }
}

export async function sessionStop(ctx: CliContext, id: string): Promise<StoredSession> {
  assertHuman(ctx.io);
  const registry = new SessionRegistry(ctx.root);
  try {
    return stopSession(registry, id);
  } finally {
    registry.close();
  }
}

export async function sessionCommand(io: Io, sub: string | undefined, rest: string[], values: Record<string, string | boolean | undefined>, json: boolean): Promise<{ value: unknown; text: string }> {
  const ctx = await repoContext(io, json);
  if (sub === "start") {
    const id = rest[0];
    if (!id) throw new CliError("usage: sdlc session start <CHG> [--kind intent|design|plan|build|review|diagnose] [--task <id>] [--target <text>] [--mode AUTO|PLAN|SUPERVISED|HEADLESS] [--detach]");
    const r = await sessionStart(ctx, id, {
      ...(typeof values["kind"] === "string" ? { kind: values["kind"] as LaunchInput["kind"] } : {}),
      ...(typeof values["task"] === "string" ? { taskId: values["task"] } : {}),
      ...(typeof values["target"] === "string" ? { target: values["target"] } : {}),
      ...(typeof values["mode"] === "string" ? { mode: values["mode"] as LaunchInput["mode"] } : {}),
      ...(values["detach"] === true ? { detach: true } : {}),
    });
    return { value: r, text: `${r.session.id} ${r.session.status} (${r.session.mode}) · ${r.session.branch}${r.exitCode !== null ? ` · exit ${r.exitCode}` : ""}${r.session.error ? `\n${r.session.error}` : ""}` };
  }
  if (sub === "list") {
    const list = await sessionList(ctx);
    return { value: list, text: list.length === 0 ? "no sessions" : list.map((s) => `${s.id}  ${s.status.padEnd(18)} ${s.mode.padEnd(10)} ${s.changeId}  ${s.branch}  loop:${s.loop.state}${s.waitingOnYou ? `  waiting on you: ${s.waitingOnYou.reason}` : ""}`).join("\n") };
  }
  if (sub === "stop") {
    const id = rest[0];
    if (!id) throw new CliError("usage: sdlc session stop <id>");
    const s = await sessionStop(ctx, id);
    return { value: s, text: `${s.id} ${s.status}` };
  }
  throw new CliError("usage: sdlc session start|list|stop");
}

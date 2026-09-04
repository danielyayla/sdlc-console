import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blobSha } from "@sdlc/adapter-git";
import { loop, validateWritePlan, type ChangeView, type WritePlan } from "@sdlc/core";
import { parseFrontMatter, stringifyFrontMatter } from "@sdlc/schemas";
import { actingIdentity, assertHuman, commitPlan, loadCommitted, transitionContext, viewOf, type CliContext } from "../context.js";
import { commitOnBranch } from "@sdlc/server";
import { CliError } from "../io.js";

export interface LoopOptions {
  /** Path to an incident record to commit first (front-matter optional; filled in). */
  incident?: string;
}

export interface LoopResult {
  id: string;
  cycle: number;
  commits: string[];
  view: ChangeView;
  /** GitHub mode: the incident went on this branch for review; merging its PR is the gate 6 decision. */
  inReview?: string;
}

export async function loopCommand(ctx: CliContext, id: string, opts: LoopOptions): Promise<LoopResult> {
  assertHuman(ctx.io);
  const who = await actingIdentity(ctx);
  const commits: string[] = [];
  let { repo } = await loadCommitted(ctx);
  let view = viewOf(repo, id);

  if (opts.incident) {
    if (view.stage !== 6) throw new CliError(`${id} is at stage ${view.stage}; incidents are recorded at stage 6 (${view.status})`, 2);
    const raw = readFileSync(resolve(ctx.io.cwd, opts.incident), "utf8");
    const split = parseFrontMatter(raw, opts.incident);
    const data = split.value?.data ?? {};
    const body = split.value?.body ?? raw;
    const ctxT = transitionContext(who);
    const fm = {
      id,
      artifact: "incident",
      cycle: view.cycle,
      src: typeof data["src"] === "string" && data["src"] !== "" ? data["src"] : "manual",
      tier: typeof data["tier"] === "string" && data["tier"] !== "" ? data["tier"] : "incident",
      created: typeof data["created"] === "string" && data["created"] !== "" ? data["created"] : ctxT.now,
      schema: 1,
    };
    const content = stringifyFrontMatter(fm, body);
    const files = repo.changes.get(id);
    const seq = files ? Math.max(0, ...files.events.map((e) => e.seq)) + 1 : 1;
    const plan: WritePlan = {
      changeId: id,
      files: [{ path: `sdlc/changes/${id}/incident.md`, content }],
      events: [
        {
          changeId: id,
          event: {
            schema: 1,
            id: ctxT.newId(),
            ts: ctxT.now,
            seq,
            cycle: view.cycle,
            actor: { type: "human", id: who.id },
            event: "artifact.committed",
            data: { artifact: 5, path: `sdlc/changes/${id}/incident.md`, sha: blobSha(content) },
          },
        },
      ],
      commitMessage: `sdlc(${id}): commit incident.md`,
      trailers: { "SDLC-Actor": `human:${who.id}` },
      actor: { type: "human", id: who.id },
    };
    if (repo.config.codeHost === "github") {
      // the incident is an artifact PR (2.2): it goes on sdlc/<CHG>/incident, the engine (or sdlc sync) opens the PR, merging it closes the loop
      const report = validateWritePlan(repo, plan);
      if (report.blocking) throw new CliError("write-plan rejected by validation", 1, report.diagnostics.filter((d) => d.blocking));
      const branch = `sdlc/${id}/incident`;
      commits.push(await commitOnBranch(ctx.root, branch, plan, who));
      return { id, cycle: view.cycle, commits, view, inReview: branch };
    }
    commits.push(await commitPlan(ctx, repo, plan, who));
    ({ repo } = await loadCommitted(ctx));
    view = viewOf(repo, id);
  }

  const r = loop(repo, view, transitionContext(who));
  if (!r.ok) throw new CliError("loop refused", 2, r.diagnostics);
  commits.push(await commitPlan(ctx, repo, r.plan, who));
  const after = await loadCommitted(ctx);
  const next = viewOf(after.repo, id);
  return { id, cycle: next.cycle, commits, view: next };
}

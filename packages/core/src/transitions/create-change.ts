import { stringifyFrontMatter, stringifyYaml, type Change, type OriginType } from "@sdlc/schemas";
import { nextChangeId } from "../ids.js";
import type { Repo } from "../repo.js";
import { readFile } from "../tree.js";
import { refuse, type TransitionResult, type WritePlan } from "../writeplan.js";
import { blobShaOf, EventBuilder, trailersFor, type TransitionContext } from "./context.js";

export interface CreateChangeInput {
  title: string;
  kind: Change["kind"];
  risk: Change["risk"];
  origin: { type: OriginType; ref?: string };
  /** Markdown body (no front-matter). Falls back to the repo's intent template. */
  intentBody?: string;
  record?: Change["record"];
}

const BUILTIN_INTENT_BODY = `# Intent: <title>

## Problem
<what cannot be done today, who is affected>

## Proposed outcome
<what better looks like>

## Affected users and systems

## Constraints

## Open questions
`;

function stripFrontMatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** Allocate an id and write change.yaml + intent.md (FR-10). Pure. */
export function createChange(repo: Repo, input: CreateChangeInput, ctx: TransitionContext): TransitionResult {
  if (input.title.trim() === "") return refuse("change.title.empty", "a change needs a title");
  const ids = new Set<string>(repo.changes.keys());
  for (const id of ctx.knownIds ?? []) ids.add(id);
  const id = nextChangeId(ids);
  const dir = `sdlc/changes/${id}`;
  const template = readFile(repo.tree, "sdlc/templates/intent.md")?.content;
  let body = input.intentBody ?? stripFrontMatter(template ?? BUILTIN_INTENT_BODY);
  body = body.replace(/^# Intent: .*$/m, `# Intent: ${input.title}`);
  if (!/^# /m.test(body)) body = `# Intent: ${input.title}\n\n${body}`;

  const change: Change = {
    schema: 1,
    id,
    title: input.title,
    kind: input.kind,
    risk: input.risk,
    created: { by: ctx.actor.id, at: ctx.now },
    origin: input.origin.ref ? { type: input.origin.type, ref: input.origin.ref } : { type: input.origin.type },
    record: input.record ?? null,
    cycle: 1,
    repro: null,
    closed: null,
  };
  const intent = stringifyFrontMatter(
    { id, artifact: "intent", cycle: 1, author: ctx.actor.id, created: ctx.now, status: "draft", schema: 1 },
    body,
  );
  const ev = new EventBuilder(ctx, null, id);
  const originRef = input.origin.ref ? `${input.origin.type}:${input.origin.ref}` : input.origin.type;
  const events = [
    ev.human("change.created", null, 1, { origin: originRef }),
    ev.human("artifact.committed", null, 1, { artifact: 0, path: `${dir}/intent.md`, sha: blobShaOf(ctx, intent) }),
  ];
  const plan: WritePlan = {
    changeId: id,
    files: [
      { path: `${dir}/change.yaml`, content: stringifyYaml(change) },
      { path: `${dir}/intent.md`, content: intent },
    ],
    events: events.map((e) => ev.write(e)),
    commitMessage: `sdlc(${id}): create change · intent.md`,
    trailers: trailersFor(events, ctx.actor),
    actor: { type: "human", id: ctx.actor.id },
  };
  return { ok: true, plan };
}

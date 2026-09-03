import type { ContextBundle } from "@sdlc/mcp";
import type { ChangeView } from "@sdlc/core";
import type { SessionKind } from "./registry.js";

export interface PromptInput {
  view: ChangeView;
  bundle: ContextBundle;
  sessionId: string;
  target: string | null;
  guidance?: string | null;
}

const COMMON = (p: PromptInput) => `You are working on change ${p.view.id} ("${p.view.title}", cycle ${p.view.cycle}) in an AI-native SDLC. Files in git are the source of truth; humans decide at gates; you never accept, merge or approve anything.
Your session id is ${p.sessionId}. Use the sdlc MCP tools (mcp__sdlc__*) with sessionId "${p.sessionId}" and changeId "${p.view.id}".
Start by calling mcp__sdlc__get_context (changeId ${p.view.id}) and reading the files it lists; they are already on disk in this worktree.
Context manifest: ${p.bundle.manifest}.`;

export function promptFor(kind: SessionKind, p: PromptInput): string {
  const guidance = p.guidance ? `\n\nGuidance from the engineer:\n${p.guidance}\n` : "";
  switch (kind) {
    case "intent":
      return `${COMMON(p)}

Task: write intent.md for this change following sdlc/templates/intent.md (sections: Problem, Proposed outcome, Affected users and systems, Constraints, Open questions). Fill every section with substance. Submit it with mcp__sdlc__propose_artifact (index 0, body = the markdown body without front-matter). Fix any diagnostics it returns and resubmit. Do not accept the gate; the product owner does.${guidance}`;
    case "design":
      return `${COMMON(p)}

Task: turn the accepted intent.md into spec.md following sdlc/templates/spec.md (Requirements, Design, Areas of concern, Open questions carried forward). Apply the org skills under .claude/skills. Flag every concern with the policy it touches and its owner in "Areas of concern" and pass them as frontMatter.concerns [{id, policy, owner, resolved:false}]. Submit with mcp__sdlc__propose_artifact (index 1). Do not resolve concerns or approve anything.${guidance}`;
    case "plan":
      return `${COMMON(p)}

Task: read the accepted intent.md and spec.md and this codebase (read-only), then write plan.md following sdlc/templates/plan.md with sections "Files that change" (one path per line, new files marked (new)), "Order of work" (numbered), "Risks", "Proof". Submit drafts with mcp__sdlc__submit_plan_revision (final=false); when you are confident an engineer who never saw this conversation could implement it, submit with final=true and an acceptanceLine (a quantifiable done criterion). Ask the engineer with mcp__sdlc__request_input only if a decision genuinely blocks you. Do not edit files other than through the tool.${guidance}`;
    case "build":
      return `${COMMON(p)}

Task: implement the accepted plan.md in this worktree on the current branch. Target (done criterion): ${p.target ?? "see plan.md acceptance line"}.
Rules: stay within the files listed in plan.md (the plan-sync hook blocks commits outside it — update plan.md in the same commit if the plan must change); never edit tests under a test freeze (the test-freeze hook blocks it — use mcp__sdlc__request_input to propose test changes); run the verification commands from CLAUDE.md after every meaningful step and record each run with mcp__sdlc__report_round (one result per command, verbatim output excerpt); commit your work on this branch with messages like "sdlc(${p.view.id}): <what>"; when the last round is all green, call mcp__sdlc__report_done. Done is only accepted when the latest round is green with output.${guidance}`;
    case "diagnose":
      return `${COMMON(p)}

Task: diagnose the incident for this deployed change using read-only tools and write incident.md following sdlc/templates/incident.md (Anomaly and evidence, Proposed outcome, Affected systems, Open questions). Submit with mcp__sdlc__propose_artifact (index 5, frontMatter {src, tier:"incident"}). Do not change code.${guidance}`;
  }
}

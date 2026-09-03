import type { ChangeView, DocState } from "@sdlc/core";

export const STAGE_NAMES = ["Plan", "Design", "Build", "Test", "Deploy", "Maintain"] as const;
export const ARTIFACT_NAMES = ["intent.md", "spec.md", "plan.md", "evals", "PR + findings", "incident"] as const;
export const ARTIFACT_FILES = ["intent.md", "spec.md", "plan.md", "evals", "pr.yaml", "incident.md"] as const;

export type Role = "po" | "eng";
export const ROLE_LABEL: Record<Role, string> = { po: "product owner", eng: "engineer" };

/** "2h ago", "3d ago", "just now" — relative to `now` for testability. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}

/** "waiting 2h" for gate rows and strips. */
export function waitingFor(iso: string, now: Date = new Date()): string {
  const rel = relativeTime(iso, now);
  return rel === "just now" ? "waiting <1m" : `waiting ${rel.replace(" ago", "")}`;
}

export function riskLabel(risk: ChangeView["risk"]): string {
  return risk === "high" ? "high risk" : "routine";
}

/** Stepper dot colour per spec §4 (Change detail). */
export function dotClass(state: DocState, isCurrent: boolean, agent: boolean, isPlanDraft: boolean): string {
  if (state === "committed" || state === "stale") return "dot green";
  if (state === "pending-review") return "dot amber";
  if (isPlanDraft) return "dot orange pulse";
  if (isCurrent && agent) return "dot orange pulse";
  return "dot inactive";
}

/** Viewer header state text. */
export function viewerState(doc: ChangeView["docs"][0], view: ChangeView): string {
  const parts: string[] = [];
  if (doc.state === "absent") parts.push("not committed");
  else if (doc.state === "committed") parts.push("committed");
  else if (doc.state === "stale") parts.push("committed · edited after acceptance");
  else if (doc.state === "pending-review") parts.push("pending review");
  else parts.push(doc.index === 2 ? `draft (rev ${view.planRev})` : "draft");
  if (doc.state !== "absent") parts.push(recordState(doc));
  return parts.join(" · ");
}

/** Spec 5A.6: "authoritative" / "copy of <record> · synced <time>" — linked mode is authoritative but names the record it is tied to. */
export function recordState(doc: ChangeView["docs"][0]): string {
  const r = doc.record;
  if (r.mode === "repo") return "authoritative";
  const synced = r.syncedAt ? `synced ${r.syncedAt.replace("T", " ").replace(/:\d\dZ$/, "")}` : "not synced";
  const who = r.chip ?? "external record (none linked)";
  return r.mode === "external" ? `copy of ${who} · ${synced}` : `authoritative · linked to ${who} · ${synced}`;
}

/** Gate label for a change in the column strip: "Accept intent.md" / "Merge PR" / "Accept plan.md · tech lead". */
export function gateOwnerLabel(view: ChangeView): string {
  if (!view.gate) return "";
  return view.gate.ownerRole === "tech_lead" ? "TECH LEAD" : view.gate.ownerRole === "po" ? "PO" : "ENG";
}

export function ownsGate(view: ChangeView, role: Role): boolean {
  return view.gate !== null && view.gate.ownerRole === role;
}

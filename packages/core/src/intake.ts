import { stringifyFrontMatter, stringifyYaml, type ClaudeSecurityDelivery, type ClaudeTagDelivery, type Finding, type Triage } from "@sdlc/schemas";
import { nextId } from "./ids.js";
import type { Repo } from "./repo.js";
import { SYSTEM_ACTOR } from "./transitions/context.js";
import { refuse, type TransitionResult, type WritePlan } from "./writeplan.js";

/**
 * Maintain intake (build-order 3.5): scanner deliveries become findings and
 * channel messages become triage items, as write-plans. The webhook receiver
 * and `sdlc ingest` both call these; the transformation itself sees no HTTP,
 * no signature and no cache — only the tree and the validated envelope.
 */

export const SECURITY_SOURCE = "claude-security" as const;

/** The console's scanner id for a Claude Security finding: matched on re-report (decisions Q12). */
export function securityScannerId(findingId: string): string {
  return `${SECURITY_SOURCE}:${findingId}`;
}

function findingPath(id: string): string {
  return `sdlc/security/findings/${id}.yaml`;
}

export interface SecurityIngest {
  created: string[];
  updated: string[];
  resolved: string[];
  /** Known findings whose scanner fields did not change. */
  unchanged: string[];
  /** Scanner ids reported resolved that the console never had: nothing to mark. */
  unknownResolved: string[];
}

function scannerFields(d: ClaudeSecurityDelivery, f: ClaudeSecurityDelivery["findings"][number], now: string): Pick<Finding, "sev" | "conf" | "validated" | "title" | "desc" | "source" | "run" | "location" | "rule" | "cwe" | "evidence" | "url"> {
  const at = d.run.finishedAt ?? d.run.startedAt ?? now;
  return {
    sev: f.severity,
    conf: f.confidence,
    ...(f.validated !== undefined ? { validated: f.validated } : {}),
    title: f.title,
    desc: f.description ?? "",
    source: SECURITY_SOURCE,
    run: { id: d.run.id, ...(d.run.url ? { url: d.run.url } : {}), at, ...(d.repo.commit ? { commit: d.repo.commit } : {}) },
    ...(f.location ? { location: f.location } : {}),
    ...(f.rule ? { rule: f.rule } : {}),
    ...(f.cwe ? { cwe: f.cwe } : {}),
    ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
    ...(f.url ? { url: f.url } : {}),
  };
}

/** Rebuild a finding in the schema's key order so the YAML diff is the change and nothing else. */
function orderFinding(f: Finding): Finding {
  const { schema, id, scannerId, sev, conf, validated, repo, title, desc, status, dismissal, escalatedTo, patchPr, source, run, location, rule, cwe, evidence, url, resolved } = f;
  return {
    schema,
    id,
    scannerId,
    sev,
    conf,
    ...(validated !== undefined ? { validated } : {}),
    repo,
    title,
    desc,
    status,
    ...(dismissal ? { dismissal } : {}),
    ...(escalatedTo ? { escalatedTo } : {}),
    ...(patchPr ? { patchPr } : {}),
    ...(source ? { source } : {}),
    ...(run ? { run } : {}),
    ...(location ? { location } : {}),
    ...(rule ? { rule } : {}),
    ...(cwe ? { cwe } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(url ? { url } : {}),
    ...(resolved ? { resolved } : {}),
  };
}

/**
 * A Claude Security delivery onto `sdlc/security/findings/`: unknown scanner
 * ids get the next SEC-NNNN as `new`; known ids take the scanner's fields and
 * keep the console's routing status, so a dismissed finding never returns as
 * `new` (FR-62, Q12); `status: resolved` sets `resolved{at, run}` and keeps
 * the file, and an `open` re-report clears it. sdlc-bot commits with the
 * delivery id and the run as trailers. Refuses when nothing would change.
 */
export function ingestSecurityDelivery(repo: Repo, d: ClaudeSecurityDelivery, ctx: { now: string }): TransitionResult & { ingest?: SecurityIngest } {
  const known = new Map(repo.findings.map((f) => [f.scannerId, f]));
  const ids = new Set(repo.findings.map((f) => f.id));
  const files: WritePlan["files"] = [];
  const ingest: SecurityIngest = { created: [], updated: [], resolved: [], unchanged: [], unknownResolved: [] };
  const seen = new Set<string>();
  for (const f of d.findings) {
    const scannerId = securityScannerId(f.id);
    if (seen.has(scannerId)) continue; // a delivery listing the same finding twice: first wins
    seen.add(scannerId);
    const existing = known.get(scannerId);
    const fields = scannerFields(d, f, ctx.now);
    const at = fields.run?.at ?? ctx.now;
    if (f.status === "resolved") {
      if (!existing) {
        ingest.unknownResolved.push(f.id);
        continue;
      }
      if (existing.resolved) {
        ingest.unchanged.push(existing.id);
        continue;
      }
      const next = orderFinding({ ...existing, ...fields, resolved: { at, run: d.run.id } });
      files.push({ path: findingPath(existing.id), content: stringifyYaml(next) });
      ingest.resolved.push(existing.id);
      continue;
    }
    if (existing) {
      const { resolved: _cleared, ...reopened } = existing;
      void _cleared;
      const next = orderFinding({ ...reopened, ...fields });
      if (JSON.stringify(next) === JSON.stringify(orderFinding(existing))) {
        ingest.unchanged.push(existing.id);
        continue;
      }
      files.push({ path: findingPath(existing.id), content: stringifyYaml(next) });
      ingest.updated.push(existing.id);
      continue;
    }
    const id = nextId("SEC", ids);
    ids.add(id);
    const created = orderFinding({ schema: 1, id, scannerId, repo: d.repo.name, status: "new", ...fields });
    files.push({ path: findingPath(id), content: stringifyYaml(created) });
    ingest.created.push(id);
  }
  if (files.length === 0) {
    return { ...refuse("intake.nothing-new", `run ${d.run.id}: every finding is already on file and unchanged`), ingest };
  }
  const parts = [
    ingest.created.length > 0 ? `${ingest.created.length} new` : "",
    ingest.updated.length > 0 ? `${ingest.updated.length} updated` : "",
    ingest.resolved.length > 0 ? `${ingest.resolved.length} resolved` : "",
  ].filter(Boolean);
  return {
    ok: true,
    ingest,
    plan: {
      changeId: null,
      files,
      events: [],
      commitMessage: `sdlc(security): ${SECURITY_SOURCE} run ${d.run.id} — ${parts.join(", ")}`,
      trailers: { "SDLC-Actor": `system:${SYSTEM_ACTOR.id}`, "SDLC-Delivery": `${SECURITY_SOURCE}:${d.deliveryId}`, "SDLC-Scan": d.run.id },
      actor: SYSTEM_ACTOR,
    },
  };
}

/** The triage item already holding a channel message, whatever its status. */
export function triageForMessage(repo: Pick<Repo, "triage">, messageId: string): Triage | null {
  return repo.triage.find((t) => t.data.channel?.messageId === messageId)?.data ?? null;
}

/** `src` of a channel item: `channel:<workspace>:<name>` (the seed's `channel:slack:#support`). */
export function channelSrc(d: Pick<ClaudeTagDelivery, "channel">): string {
  return `channel:${d.channel.workspace ? `${d.channel.workspace}:` : ""}${d.channel.name}`;
}

function channelTitle(d: ClaudeTagDelivery): string {
  if (d.title) return d.title;
  const first = d.message.text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? d.message.text.trim();
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
}

/** The evidence a channel item carries: who said what where, the permalink, then the message and thread verbatim. */
export function channelEvidence(d: ClaudeTagDelivery): string {
  const head = `${d.message.author} in ${d.channel.name}${d.message.postedAt ? ` at ${d.message.postedAt}` : ""}${d.tags && d.tags.length > 0 ? ` · tags: ${d.tags.join(", ")}` : ""}\n${d.message.permalink}`;
  const thread = (d.thread ?? []).map((m) => `--- ${m.author}${m.postedAt ? ` at ${m.postedAt}` : ""}\n${m.text.trimEnd()}`).join("\n");
  return `${head}\n---\n${d.message.text.trimEnd()}\n${thread ? `${thread}\n` : ""}`;
}

function channelBody(d: ClaudeTagDelivery, title: string): string {
  const thread = d.thread ?? [];
  return `# Intent: ${title}

## Problem
${d.message.text.trim()}

Reported by ${d.message.author} in ${d.channel.name} (${d.message.permalink}).

## Proposed outcome
To be drafted by the owner who accepts this item; the message above is the report, not the outcome.

## Affected users and systems
Whoever ${d.channel.name} serves; see the thread.

## Constraints
None recorded at intake.

## Open questions
${thread.length > 0 ? thread.map((m) => `- ${m.author}: ${m.text.trim().split("\n")[0] ?? ""}`).join("\n") : "What did the reporter expect to happen instead?"}
`;
}

/**
 * A Claude Tag delivery onto `sdlc/loop/triage/`: one `channel` item per
 * message id (a second delivery for the same message, whatever its delivery
 * id, is a no-op naming the item), with the message and thread verbatim as
 * evidence, a pre-drafted intent as the body, and the origin on the item so
 * Accept → Plan carries the link. sdlc-bot commits.
 */
export function ingestChannelDelivery(repo: Repo, d: ClaudeTagDelivery, ctx: { now: string }): TransitionResult & { id?: string; duplicateOf?: string } {
  const prior = triageForMessage(repo, d.message.id);
  if (prior) return { ...refuse("intake.duplicate", `message ${d.message.id} is already ${prior.id} (${prior.status})`), duplicateOf: prior.id };
  const id = nextId("TRI", repo.triage.map((t) => t.data.id));
  const title = channelTitle(d);
  const data: Triage = {
    schema: 1,
    id,
    tier: "channel",
    src: channelSrc(d),
    title,
    evidence: channelEvidence(d),
    createdAt: ctx.now,
    status: "open",
    channel: {
      name: d.channel.name,
      ...(d.channel.workspace ? { workspace: d.channel.workspace } : {}),
      messageId: d.message.id,
      permalink: d.message.permalink,
      author: d.message.author,
      ...(d.message.postedAt ? { postedAt: d.message.postedAt } : {}),
      ...(d.tags && d.tags.length > 0 ? { tags: d.tags } : {}),
    },
  };
  return {
    ok: true,
    id,
    plan: {
      changeId: null,
      files: [{ path: `sdlc/loop/triage/${id}.md`, content: stringifyFrontMatter(data as unknown as Record<string, unknown>, channelBody(d, title)) }],
      events: [],
      commitMessage: `sdlc(loop): ${id} from ${data.src} — ${title}`,
      trailers: { "SDLC-Actor": `system:${SYSTEM_ACTOR.id}`, "SDLC-Delivery": `claude-tag:${d.deliveryId}`, "SDLC-Message": d.message.id },
      actor: SYSTEM_ACTOR,
    },
  };
}

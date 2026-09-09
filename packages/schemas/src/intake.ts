import { z } from "zod";
import { isoTimestamp, nonEmpty, ratio, schemaVersion, severity } from "./common.js";

/**
 * Maintain intake envelopes (build-order 3.5). The vendor wire formats of
 * Claude Security and Claude Tag are not pinned here; both deliveries are
 * accepted in a versioned envelope of our own (`schema: 1`) that a thin relay
 * or the vendor's outgoing webhook fills in. The console validates the
 * envelope, never a guessed vendor shape, so a format change is a schema bump
 * with a migration rather than a silent misread.
 */

/** One finding as the scanner reports it; `id` is the scanner's own id, stable across runs. */
export const scannerFinding = z.strictObject({
  id: nonEmpty,
  /** `resolved` marks a finding the scanner no longer sees; the console keeps the file and its routing status. `open` when absent. */
  status: z.enum(["open", "resolved"]).optional(),
  title: nonEmpty,
  severity,
  confidence: ratio,
  validated: z.boolean().optional(),
  description: z.string().optional(),
  /** The scanner's own evidence (snippet, trace, reasoning), kept verbatim on the finding. */
  evidence: z.string().optional(),
  location: z
    .strictObject({
      path: nonEmpty,
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    })
    .optional(),
  rule: nonEmpty.optional(),
  cwe: nonEmpty.optional(),
  /** Where the scanner shows this finding. */
  url: z.url().optional(),
});

/** `POST /api/webhooks/claude-security` body and `sdlc ingest security <file>` input. */
export const claudeSecurityDelivery = z.strictObject({
  schema: schemaVersion,
  source: z.literal("claude-security"),
  /** Unique per delivery; a redelivery reuses it and is a no-op. */
  deliveryId: nonEmpty,
  run: z.strictObject({
    id: nonEmpty,
    url: z.url().optional(),
    startedAt: isoTimestamp.optional(),
    finishedAt: isoTimestamp.optional(),
  }),
  repo: z.strictObject({
    name: nonEmpty,
    commit: z.string().optional(),
  }),
  findings: z.array(scannerFinding),
});

/** One message in the thread around the tagged message. */
export const channelMessage = z.strictObject({
  id: nonEmpty.optional(),
  author: nonEmpty,
  text: z.string(),
  postedAt: isoTimestamp.optional(),
});

/** `POST /api/webhooks/claude-tag` body and `sdlc ingest channel <file>` input. */
export const claudeTagDelivery = z.strictObject({
  schema: schemaVersion,
  source: z.literal("claude-tag"),
  deliveryId: nonEmpty,
  channel: z.strictObject({
    /** Workspace or platform, e.g. `slack`; part of the item's `src`. */
    workspace: nonEmpty.optional(),
    name: nonEmpty,
    id: nonEmpty.optional(),
  }),
  message: z.strictObject({
    /** Unique per message; one triage item per message id, whatever the delivery id. */
    id: nonEmpty,
    permalink: z.url(),
    author: nonEmpty,
    text: nonEmpty,
    postedAt: isoTimestamp.optional(),
  }),
  thread: z.array(channelMessage).optional(),
  tags: z.array(nonEmpty).optional(),
  /** A title the tagger chose; the first line of the message otherwise. */
  title: nonEmpty.optional(),
});

export type ScannerFinding = z.infer<typeof scannerFinding>;
export type ClaudeSecurityDelivery = z.infer<typeof claudeSecurityDelivery>;
export type ChannelMessage = z.infer<typeof channelMessage>;
export type ClaudeTagDelivery = z.infer<typeof claudeTagDelivery>;

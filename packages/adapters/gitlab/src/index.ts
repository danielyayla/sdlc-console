/**
 * @sdlc/adapter-gitlab — code-host adapter for GitLab (blueprint §7.6,
 * build-order 3.7) behind the same `CodeHost` contract as GitHub mode:
 * merge requests as gates, commit statuses as the checks (shown in the MR
 * pipeline widget), gate 5 merged through the API under a protected target
 * branch, webhooks verified by token. Never a way around the human.
 */
export const PACKAGE_NAME = "@sdlc/adapter-gitlab" as const;

export * from "./client.js";
export * from "./remote.js";
export * from "./merge-requests.js";
export * from "./statuses.js";
export * from "./protection.js";
export * from "./codehost.js";
export * from "./webhooks.js";

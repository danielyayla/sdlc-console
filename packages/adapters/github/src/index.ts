/**
 * @sdlc/adapter-github — code-host adapter for GitHub (blueprint §7.6).
 * Token mode over the REST API: opens the code PR, publishes the evidence
 * status, merges at gate 5 under branch protection. Never a code owner,
 * never a way around the human.
 */
export const PACKAGE_NAME = "@sdlc/adapter-github" as const;

export * from "./client.js";
export * from "./remote.js";
export * from "./pulls.js";
export * from "./statuses.js";
export * from "./protection.js";
export * from "./codeowners.js";
export * from "./codehost.js";

/**
 * @sdlc/hooks — plan-sync, test-freeze, verify-before-done as thin adapters
 * over the pure checks in @sdlc/core, invoked by `sdlc hook <name>`.
 */
export const PACKAGE_NAME = "@sdlc/hooks" as const;

export * from "./input.js";
export * from "./ledger.js";
export * from "./context.js";
export * from "./plan-sync.js";
export * from "./test-freeze.js";
export * from "./verify-before-done.js";
export * from "./run.js";
export * from "./install.js";

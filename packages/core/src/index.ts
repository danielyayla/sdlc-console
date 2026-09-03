/**
 * @sdlc/core — pure functions over a `Tree` snapshot (path → content + SHA).
 *
 * No I/O and no Node builtins: this package must run anywhere. Adapters do I/O.
 * ESLint enforces this for `packages/core/src/**`; the package test enforces
 * that no runtime dependency outside the `@sdlc/` scope is declared.
 */
export const PACKAGE_NAME = "@sdlc/core" as const;

export * from "./tree.js";
export * from "./stages.js";
export * from "./modes.js";
export * from "./config.js";
export * from "./fingerprint.js";
export * from "./events.js";
export * from "./activity.js";
export * from "./eligibility.js";
export * from "./repo.js";
export * from "./derive.js";
export * from "./queues.js";
export * from "./ids.js";
export * from "./writeplan.js";
export * from "./transitions/index.js";
export * from "./validate/index.js";
export * from "./metrics.js";
export * from "./evals.js";

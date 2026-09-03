/**
 * @sdlc/core — pure functions over a `Tree` snapshot (path → content + SHA).
 *
 * No I/O and no Node builtins: this package must run anywhere. Adapters do I/O.
 * ESLint enforces this for `packages/core/src/**`; the package test enforces
 * that no runtime dependency outside the `@sdlc/` scope is declared.
 */
export const PACKAGE_NAME = "@sdlc/core" as const;

/**
 * @sdlc/adapter-git — thin wrapper over the real `git` CLI.
 * The only component that writes to the repo: applies write-plans as commits,
 * reads trees at refs, manages worktrees, unions ledgers across branches.
 */
export const PACKAGE_NAME = "@sdlc/adapter-git" as const;

export * from "./git.js";
export * from "./sha.js";
export * from "./ids.js";
export * from "./tree.js";
export * from "./commit.js";
export * from "./worktree.js";
export * from "./ledger.js";
export * from "./attributes.js";

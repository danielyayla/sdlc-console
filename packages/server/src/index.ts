/**
 * @sdlc/server — `sdlc serve`: watcher, derived snapshot over WebSocket,
 * HTTP actions, local identity. Hosts core + adapters in one process.
 */
export const PACKAGE_NAME = "@sdlc/server" as const;

export * from "./snapshot.js";
export * from "./store.js";
export * from "./watcher.js";
export * from "./actions.js";
export * from "./http.js";
export * from "./serve.js";
export * from "./sessions/index.js";
export * from "./engine/index.js";
export * from "./github/index.js";

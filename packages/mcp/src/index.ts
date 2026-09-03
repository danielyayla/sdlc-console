/**
 * @sdlc/mcp — sdlc-mcp: agent-facing tools over MCP. No accept/merge/approve tool exists.
 */
export const PACKAGE_NAME = "@sdlc/mcp" as const;

export * from "./identity.js";
export * from "./context-bundle.js";
export * from "./sessions.js";
export * from "./tools.js";
export * from "./server.js";

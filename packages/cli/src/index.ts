/**
 * @sdlc/cli — the human-facing `sdlc` command line.
 * Refuses mutations when SDLC_ACTOR_TYPE=agent; every command speaks --json.
 */
export const PACKAGE_NAME = "@sdlc/cli" as const;

export { main, USAGE } from "./main.js";
export type { Io } from "./io.js";
export { CliError } from "./io.js";

import { exitCodeFor, renderDetection, runDetection, type DetectionPass, type Exec } from "@sdlc/detect";
import type { CliContext } from "../context.js";

/**
 * `sdlc detect [--json]`: the deterministic detection script on this home
 * (build-order 3.4) — every `source:` in bands.yaml measured once, the
 * snapshots written under `.sdlc-state/snapshots/`, the table printed with
 * the sources' output verbatim for anything failed or beyond 1σ. Raising
 * triage items and jobs from the tiers is `sdlc serve --engine`'s part; here
 * the exit code carries the verdict (2 at ≥2σ, 1 on a failed source).
 */
export async function detectCommand(ctx: CliContext, exec?: Exec): Promise<{ pass: DetectionPass; exitCode: 0 | 1 | 2 }> {
  const pass = await runDetection({ home: ctx.root, ...(exec ? { exec } : {}) });
  return { pass, exitCode: exitCodeFor(pass) };
}

export { renderDetection };

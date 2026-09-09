import { describe, expect, it } from "vitest";
import { evalsWorkflow } from "../src/workflows.js";

describe("generated evals workflow (2.5 → e2e)", () => {
  it("pushes a PR's run file only while the PR is still open; a merged or closed PR keeps it in the job log", () => {
    const yml = evalsWorkflow({ bin: "sh scripts/sdlc.sh", install: null });
    const step = yml.slice(yml.indexOf("Keep the run file (PR branch)"), yml.indexOf("Keep the run file (sdlc/evals-runs)"));
    expect(step).toContain('gh pr view "${{ github.event.pull_request.number }}" --json state --jq .state');
    expect(step).toMatch(/if \[ "\$state" != "OPEN" \]; then[\s\S]*exit 0[\s\S]*fi\n\s+git push origin HEAD:\$\{\{ github\.head_ref \}\}/);
    expect(step).toContain("GH_TOKEN: ${{ github.token }}");
    // the unconditional push is gone
    expect(yml).not.toMatch(/run: git push origin HEAD:\$\{\{ github\.head_ref \}\}\n/);
  });
});

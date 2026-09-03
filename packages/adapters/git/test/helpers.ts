import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, initRepo, type GitIdentity } from "../src/index.js";

export const PO: GitIdentity = { id: "po@example.com", name: "Pat Owner" };
export const ENG: GitIdentity = { id: "eng@example.com", name: "Eng Ineer" };

export const BASE_FILES: Record<string, string> = {
  "CLAUDE.md": "# P\n\n## Verifying your work\n- Build: `pnpm build`\n- Test: `pnpm test` (all green)\n- Lint: `pnpm lint`\n",
  "sdlc/config.yaml": "schema: 1\ndefaultRole: po\nidentities:\n  - { id: po@example.com, roles: [po] }\n  - { id: eng@example.com, roles: [eng, tech_lead] }\n",
  "sdlc/templates/intent.md": "---\nid: CHG-0000\nartifact: intent\ncycle: 1\nauthor: \ncreated: \nstatus: draft\nschema: 1\n---\n# Intent: <title>\n\n## Problem\n<p>\n\n## Proposed outcome\n<o>\n\n## Affected users and systems\n\n## Constraints\n\n## Open questions\n",
  "README.md": "hello\n",
};

export async function tempRepo(files: Record<string, string> = BASE_FILES): Promise<{ dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-git-"));
  await initRepo(dir, "main", PO);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "baseline"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
}

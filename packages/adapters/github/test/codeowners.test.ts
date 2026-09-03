import { describe, expect, it } from "vitest";
import type { Tree } from "@sdlc/core";
import { codeownersFromTree, codeownersGlobs, ownersFor, parseCodeowners } from "../src/index.js";

const FILE = `# default owners
*                @acme/all
*.ts             @acme/ts
/docs/           @acme/docs
apps/            @acme/apps
/src/export/csv.ts @acme/csv  # trailing comment
sdlc/config.yaml @acme/platform
`;

describe("CODEOWNERS", () => {
  it("parses rules, skipping comments and blank lines", () => {
    const rules = parseCodeowners(FILE);
    expect(rules.map((r) => [r.pattern, r.owners])).toEqual([
      ["*", ["@acme/all"]],
      ["*.ts", ["@acme/ts"]],
      ["/docs/", ["@acme/docs"]],
      ["apps/", ["@acme/apps"]],
      ["/src/export/csv.ts", ["@acme/csv"]],
      ["sdlc/config.yaml", ["@acme/platform"]],
    ]);
    expect(rules[4]?.line).toBe(6);
  });

  it("resolves owners with last-match-wins and gitignore-style anchoring", () => {
    const rules = parseCodeowners(FILE);
    expect(ownersFor(rules, "README.md")).toEqual(["@acme/all"]);
    expect(ownersFor(rules, "packages/core/src/derive.ts")).toEqual(["@acme/ts"]);
    expect(ownersFor(rules, "docs/decisions.md")).toEqual(["@acme/docs"]);
    expect(ownersFor(rules, "site/docs/x.md")).toEqual(["@acme/all"]);
    expect(ownersFor(rules, "monorepo/apps/web/index.ts")).toEqual(["@acme/apps"]);
    expect(ownersFor(rules, "src/export/csv.ts")).toEqual(["@acme/csv"]);
    expect(ownersFor(rules, "sdlc/config.yaml")).toEqual(["@acme/platform"]);
    expect(ownersFor([], "anything")).toEqual([]);
  });

  it("turns patterns into globs", () => {
    expect(codeownersGlobs("*.ts")).toEqual(["**/*.ts"]);
    expect(codeownersGlobs("/docs/")).toEqual(["docs/**"]);
    expect(codeownersGlobs("apps/")).toEqual(["**/apps/**"]);
    expect(codeownersGlobs("docs/*")).toEqual(["docs/*"]);
    expect(codeownersGlobs("LICENSE")).toEqual(["**/LICENSE", "**/LICENSE/**"]);
  });

  it("reads the first CODEOWNERS location GitHub would use", () => {
    const tree: Tree = { ref: "HEAD", files: new Map([[".github/CODEOWNERS", { content: "* @a\n", sha: "x" }], ["docs/CODEOWNERS", { content: "* @b\n", sha: "y" }]]) };
    expect(codeownersFromTree(tree)).toEqual({ path: ".github/CODEOWNERS", rules: [{ pattern: "*", owners: ["@a"], line: 1 }] });
    expect(codeownersFromTree({ ref: "HEAD", files: new Map() })).toBeNull();
  });
});

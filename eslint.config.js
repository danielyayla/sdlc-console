import { builtinModules } from "node:module";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const NO_IO_MESSAGE =
  "@sdlc/core has no I/O: it is pure functions over a Tree snapshot. Adapters do I/O.";

const nodeBuiltins = builtinModules.filter((name) => !name.startsWith("_"));

export default defineConfig([
  // A change's design/ folder holds exports (a Claude Design page, its support script), not code that ships.
  // .sdlc-state/ is the disposable cache holding session worktrees (each a full checkout with its own tsconfig.json).
  globalIgnores(["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", ".sdlc-state/**", "fixtures/seed/**", "sdlc/changes/*/design/**"]),
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Plain JS/MJS scripts (generators, config) run on Node.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    // The console runs in a browser.
    files: ["packages/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Mechanical form of the CLAUDE.md rule "packages/core has no I/O".
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: nodeBuiltins.map((name) => ({ name, message: NO_IO_MESSAGE })),
          patterns: [{ group: ["node:*"], message: NO_IO_MESSAGE }],
        },
      ],
    },
  },
]);

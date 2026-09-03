import { builtinModules } from "node:module";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const NO_IO_MESSAGE =
  "@sdlc/core has no I/O: it is pure functions over a Tree snapshot. Adapters do I/O.";

const nodeBuiltins = builtinModules.filter((name) => !name.startsWith("_"));

export default defineConfig([
  globalIgnores(["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"]),
  js.configs.recommended,
  ...tseslint.configs.strict,
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

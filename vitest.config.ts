import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import workspace packages from TypeScript source, so `pnpm test`
// never needs a prior `pnpm build`. Runtime resolution of the built
// `dist/` exports is proven separately (see sdlc/changes/CHG-0001/plan.md).
const src = (dir: string): string =>
  fileURLToPath(new URL(`./packages/${dir}/src/index.ts`, import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sdlc/schemas": src("schemas"),
      "@sdlc/core": src("core"),
      "@sdlc/adapter-git": src("adapters/git"),
      "@sdlc/hooks": src("hooks"),
      "@sdlc/server": src("server"),
      "@sdlc/cli": src("cli"),
      "@sdlc/fixtures": fixtures,
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}", "fixtures/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});

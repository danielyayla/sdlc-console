import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@sdlc/core", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/core");
  });

  it("declares no runtime dependency outside the @sdlc/ scope", () => {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const external = Object.keys(pkg.dependencies ?? {}).filter(
      (name) => !name.startsWith("@sdlc/"),
    );
    expect(external).toEqual([]);
  });
});

import { PACKAGE_NAME as CORE_PACKAGE_NAME } from "@sdlc/core";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@sdlc/cli", () => {
  it("exports its package name and resolves workspace packages", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/cli");
    expect(CORE_PACKAGE_NAME).toBe("@sdlc/core");
  });
});

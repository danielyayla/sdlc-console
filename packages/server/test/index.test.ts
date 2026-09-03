import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@sdlc/server", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/server");
  });
});

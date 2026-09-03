import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@sdlc/adapter-git", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sdlc/adapter-git");
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsonSchemas, schemaNames } from "../src/index.js";

const jsonDir = fileURLToPath(new URL("../json/", import.meta.url));

describe("json/*.schema.json is generated from the zod source", () => {
  it("has exactly one file per schema name", () => {
    const files = readdirSync(jsonDir)
      .filter((f) => f.endsWith(".schema.json"))
      .map((f) => f.replace(/\.schema\.json$/, ""))
      .sort();
    expect(files).toEqual([...schemaNames].sort());
  });

  for (const name of schemaNames) {
    it(`${name}.schema.json matches z.toJSONSchema output (run pnpm --filter @sdlc/schemas generate)`, () => {
      const onDisk: unknown = JSON.parse(readFileSync(`${jsonDir}${name}.schema.json`, "utf8"));
      expect(onDisk).toEqual(jsonSchemas[name]);
    });
  }

  it("every schema is draft 2020-12 with a stable $id", () => {
    for (const name of schemaNames) {
      expect(jsonSchemas[name]["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(jsonSchemas[name]["$id"]).toBe(`https://sdlc.local/schemas/${name}.schema.json`);
    }
  });

  it("the event schema is a discriminated oneOf so Ajv reports the matching branch only", () => {
    const ev = jsonSchemas.event;
    expect(ev["discriminator"]).toEqual({ propertyName: "event" });
    expect(Array.isArray(ev["oneOf"])).toBe(true);
  });
});

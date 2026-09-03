// Writes json/<name>.schema.json from the built package. Run after `pnpm build`.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jsonSchemas, schemaNames } from "../dist/index.js";

const outDir = fileURLToPath(new URL("../json/", import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const name of schemaNames) {
  writeFileSync(`${outDir}${name}.schema.json`, JSON.stringify(jsonSchemas[name], null, 2) + "\n");
}
console.log(`wrote ${schemaNames.length} schemas to json/`);

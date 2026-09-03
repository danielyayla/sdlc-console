// Regenerates fixtures/seed from the generator. Run after `pnpm build`.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeSeed } from "../dist/index.js";

const dir = fileURLToPath(new URL("../seed/", import.meta.url));
rmSync(dir, { recursive: true, force: true });
const written = writeSeed(dir);
console.log(`wrote ${written.length} files to fixtures/seed/`);

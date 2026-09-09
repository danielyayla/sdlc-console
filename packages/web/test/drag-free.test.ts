import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

/**
 * The spec forbids drag-and-drop on the board (blueprint item 23, decisions
 * 3.8): a card moves between columns only when a gate decision is committed,
 * never by a gesture. Nothing in the console may wire the HTML drag API or a
 * DnD library, so this test fails the moment one appears.
 */
describe("the board stays drag-free", () => {
  it("no draggable attribute, drag/drop handlers, DataTransfer or dnd library anywhere under packages/web/src", () => {
    const files = walk(SRC).filter((f) => /\.(tsx?|css|html)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    const forbidden = [/\bdraggable\b/i, /\bonDrag(Start|End|Enter|Leave|Over|Exit)?\b/, /\bonDrop\b/, /\bDataTransfer\b/, /\bdnd\b/i, /react-beautiful-dnd|@dnd-kit|react-dnd|sortablejs|interactjs/i, /\bdrag(start|end|enter|leave|over)\b/i, /addEventListener\(\s*["']drop["']/];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const re of forbidden) if (re.test(text)) offenders.push(`${file.slice(SRC.length)}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});

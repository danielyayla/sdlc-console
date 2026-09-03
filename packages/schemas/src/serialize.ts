import { stringify } from "yaml";

/** Stable YAML for `sdlc/` files: 2-space indent, no line folding, keys in object order. */
export function stringifyYaml(value: unknown): string {
  return stringify(value, { indent: 2, lineWidth: 0, nullStr: "null" });
}

/** Markdown with YAML front-matter. */
export function stringifyFrontMatter(data: Record<string, unknown>, body: string): string {
  const b = body.startsWith("\n") ? body.slice(1) : body;
  return `---\n${stringifyYaml(data)}---\n${b.endsWith("\n") ? b : `${b}\n`}`;
}

/** One JSON line per event for `log.jsonl`. */
export function stringifyJsonl(values: readonly unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join("\n") + (values.length > 0 ? "\n" : "");
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

import matter from "gray-matter";
import { parse as parseYamlText } from "yaml";
import { error, fail, finish, isRecord, type ParseResult } from "./result.js";

export interface FrontMatterSplit {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line on which the body starts. */
  bodyLine: number;
  hasFrontMatter: boolean;
}

/** Split YAML front-matter from a markdown body. Never throws. */
export function parseFrontMatter(text: string, path: string): ParseResult<FrontMatterSplit> {
  try {
    // gray-matter defaults to js-yaml, which turns unquoted timestamps into Date
    // objects; the `yaml` core schema keeps them as strings, as the schemas expect.
    const file = matter(text, { engines: { yaml: (src: string) => parseYamlText(src) as object } });
    const data = isRecord(file.data) ? file.data : {};
    const hasFrontMatter = file.matter.length > 0 || /^---\r?\n/.test(text);
    const headerLines = hasFrontMatter ? text.slice(0, text.length - file.content.length).split(/\r?\n/).length : 1;
    return finish({ data, body: file.content, bodyLine: headerLines, hasFrontMatter }, []);
  } catch (e) {
    const err = e as Error & { mark?: { line?: number } };
    const line = typeof err.mark?.line === "number" ? err.mark.line + 2 : undefined;
    return fail([error(path, "parse.frontmatter", err.message, line)]);
  }
}

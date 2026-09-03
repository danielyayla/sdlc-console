export interface Section {
  /** Heading text without the `#` marks. */
  name: string;
  level: number;
  /** 1-based line of the heading within the whole file. */
  line: number;
  /** Raw content between this heading and the next heading of any level. */
  content: string;
}

export interface MarkdownOutline {
  title: string | null;
  sections: Section[];
}

/** `<placeholder>` text or a bare list marker such as `1.` or `-`. */
const PLACEHOLDER = /^\s*(?:<[^>]*>|[-*+]|\d+[.)])\s*$/;

/** Split a markdown body into headed sections. `startLine` offsets line numbers for front-matter. */
export function outline(body: string, startLine = 1): MarkdownOutline {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let title: string | null = null;
  let current: Section | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current) current.content = buffer.join("\n").trim();
    buffer = [];
  };

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m && m[1] && m[2] !== undefined) {
      const level = m[1].length;
      if (level === 1 && title === null) {
        title = m[2];
        flush();
        current = null;
        return;
      }
      flush();
      current = { name: m[2], level, line: startLine + i, content: "" };
      sections.push(current);
      return;
    }
    if (current) buffer.push(line);
  });
  flush();
  return { title, sections };
}

/** True when a section body is blank or contains only `<placeholder>` lines. */
export function isPlaceholderContent(content: string): boolean {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.length === 0 || lines.every((l) => PLACEHOLDER.test(l));
}

export function findSection(sections: Section[], name: string): Section | undefined {
  const wanted = name.trim().toLowerCase();
  return sections.find((s) => s.name.trim().toLowerCase() === wanted);
}

export function countWords(text: string): number {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^---[\s\S]*?---/m, " ");
  return stripped.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

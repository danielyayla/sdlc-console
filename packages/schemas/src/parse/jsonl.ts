import type { Event } from "../event.js";
import { validate, type Diagnostic } from "../validate.js";
import { error, finish, type ParseResult } from "./result.js";

/**
 * Parse `log.jsonl`: one event per line, blank lines ignored. Every line is
 * validated; bad lines produce diagnostics with their line number and the
 * good lines are still returned so a single corrupt entry never hides history.
 */
export function parseJsonl(text: string, path: string): ParseResult<Event[]> {
  const events: Event[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      diagnostics.push(error(path, "parse.jsonl", (e as Error).message, lineNo));
      return;
    }
    const result = validate("event", value, path);
    if (result.ok) {
      events.push(result.value);
    } else {
      for (const d of result.diagnostics) diagnostics.push({ ...d, line: lineNo });
    }
  });
  return finish(events, diagnostics);
}

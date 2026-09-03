import type { Diagnostic } from "../validate.js";

/** Result of any parser: never throws; `ok` is false when any diagnostic is an error. */
export interface ParseResult<T> {
  ok: boolean;
  value: T | null;
  diagnostics: Diagnostic[];
}

export function error(path: string, rule: string, message: string, line?: number): Diagnostic {
  return line === undefined
    ? { path, severity: "error", rule, message }
    : { path, severity: "error", rule, message, line };
}

export function warning(path: string, rule: string, message: string, line?: number): Diagnostic {
  return line === undefined
    ? { path, severity: "warning", rule, message }
    : { path, severity: "warning", rule, message, line };
}

export function finish<T>(value: T | null, diagnostics: Diagnostic[]): ParseResult<T> {
  const ok = value !== null && diagnostics.every((d) => d.severity !== "error");
  return { ok, value: ok ? value : null, diagnostics };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A failed parse; assignable to any ParseResult<T>. */
export function fail(diagnostics: Diagnostic[]): ParseResult<never> {
  return { ok: false, value: null, diagnostics };
}

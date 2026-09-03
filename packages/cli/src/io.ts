export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whole stdin, read lazily (for `--intent -`). */
  stdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  cwd: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Fixed-width text table for human output. */
export function table(rows: readonly (readonly string[])[], header?: readonly string[]): string {
  const all = header ? [header, ...rows] : [...rows];
  const widths: number[] = [];
  for (const row of all) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  const line = (row: readonly string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return out.join("\n");
}

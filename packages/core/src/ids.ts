/** Next id = max(existing) + 1, zero-padded to 4 digits (docs/storage-layout.md). */
export function nextId(prefix: "CHG" | "TRI" | "SEC" | "PRP", existing: Iterable<string>): string {
  const re = new RegExp(`^${prefix}-(\\d{4,})$`);
  let max = 0;
  for (const id of existing) {
    const m = re.exec(id);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

export function nextChangeId(existing: Iterable<string>): string {
  return nextId("CHG", existing);
}

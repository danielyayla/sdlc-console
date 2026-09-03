import { describe, expect, it } from "vitest";
import { parseFindingsImport } from "../src/index.js";

describe("parseFindingsImport", () => {
  it("parses a CSV export with quoted fields and percentage confidence", () => {
    const csv = `scannerId,severity,confidence,repo,title,description,validated
cs:1,High,94%,invoicing,"SQL injection in filter","User input, unescaped",true
cs:2,medium,0.81,invoicing,Expiring links,,false
cs:3,critical,0.5,invoicing,Bad severity,skipped,`;
    const r = parseFindingsImport(csv, "export.csv");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([
      { scannerId: "cs:1", sev: "high", conf: 0.94, repo: "invoicing", title: "SQL injection in filter", desc: "User input, unescaped", validated: true },
      { scannerId: "cs:2", sev: "medium", conf: 0.81, repo: "invoicing", title: "Expiring links", desc: "", validated: false },
    ]);
    expect(r.diagnostics.map((d) => [d.rule, d.line])).toEqual([["import.row", 4]]);
  });
  it("parses a Markdown table", () => {
    const md = `| scannerId | sev | conf | repo | title | desc |
|---|---|---|---|---|---|
| s-9 | low | 0.6 | billing | Verbose errors | stack traces |`;
    const r = parseFindingsImport(md, "scan.md");
    expect(r.value).toEqual([{ scannerId: "s-9", sev: "low", conf: 0.6, repo: "billing", title: "Verbose errors", desc: "stack traces" }]);
  });
  it("rejects empty input and a missing header", () => {
    expect(parseFindingsImport("").ok).toBe(false);
    expect(parseFindingsImport("a,b,c\n1,2,3").ok).toBe(false);
  });
});

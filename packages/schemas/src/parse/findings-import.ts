import type { Severity } from "../common.js";
import type { Diagnostic } from "../validate.js";
import { error, fail, finish, warning, type ParseResult } from "./result.js";

export interface FindingRow {
  scannerId: string;
  sev: Severity;
  conf: number;
  repo: string;
  title: string;
  desc: string;
  validated?: boolean;
}

const HEADERS = ["scannerid", "sev", "severity", "conf", "confidence", "repo", "title", "desc", "description", "validated"];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function rowsFrom(header: string[], lines: string[][], path: string): ParseResult<FindingRow[]> {
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iScanner = idx(["scannerid", "scanner_id", "scanner", "id"]);
  const iSev = idx(["sev", "severity"]);
  const iConf = idx(["conf", "confidence"]);
  const iRepo = idx(["repo", "repository"]);
  const iTitle = idx(["title"]);
  const iDesc = idx(["desc", "description"]);
  const iValidated = idx(["validated"]);
  if (iScanner < 0 || iSev < 0 || iTitle < 0) {
    return fail([error(path, "import.header", `need columns scannerId, sev, title (got: ${header.join(", ") || "none"})`, 1)]);
  }
  const rows: FindingRow[] = [];
  const diagnostics: Diagnostic[] = [];
  lines.forEach((cells, n) => {
    const line = n + 2;
    const sevRaw = (cells[iSev] ?? "").toLowerCase();
    const sev = sevRaw === "high" || sevRaw === "medium" || sevRaw === "low" ? sevRaw : null;
    const scannerId = cells[iScanner] ?? "";
    const title = cells[iTitle] ?? "";
    if (!sev || scannerId === "" || title === "") {
      diagnostics.push(warning(path, "import.row", `row skipped: needs scannerId, sev high|medium|low and title`, line));
      return;
    }
    let conf = iConf >= 0 ? Number((cells[iConf] ?? "").replace("%", "")) : 1;
    if (Number.isNaN(conf)) conf = 1;
    if (conf > 1) conf = conf / 100;
    conf = Math.min(1, Math.max(0, conf));
    const validatedRaw = iValidated >= 0 ? (cells[iValidated] ?? "").toLowerCase() : "";
    rows.push({
      scannerId,
      sev,
      conf,
      repo: (iRepo >= 0 ? cells[iRepo] : "") || "repo",
      title,
      desc: (iDesc >= 0 ? cells[iDesc] : "") ?? "",
      ...(validatedRaw !== "" ? { validated: validatedRaw === "true" || validatedRaw === "yes" || validatedRaw === "1" } : {}),
    });
  });
  return finish(rows, diagnostics);
}

/**
 * Scanner export → finding rows. Accepts a CSV with a header row or a
 * Markdown table; column names are matched case-insensitively.
 */
export function parseFindingsImport(text: string, path = "import"): ParseResult<FindingRow[]> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return fail([error(path, "import.empty", "nothing to import")]);
  const first = lines[0] ?? "";
  if (first.trim().startsWith("|")) {
    const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const header = cells(first).map((h) => h.toLowerCase());
    const body = lines.slice(1).filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim())).map(cells);
    return rowsFrom(header, body, path);
  }
  const header = splitCsvLine(first).map((h) => h.toLowerCase());
  if (!header.some((h) => HEADERS.includes(h))) return fail([error(path, "import.header", "first line must be a header row", 1)]);
  return rowsFrom(header, lines.slice(1).map(splitCsvLine), path);
}

import Papa from "papaparse";
import { DomainError } from "@/lib/orgs";

/** Server actions accept up to 2 MB (next.config.ts); keep a margin for multipart overhead. */
export const MAX_CSV_BYTES = 1_900_000;
export const MAX_CSV_ROWS = 20_000;

export interface RawRow {
  /** 1-based line number in the file as a spreadsheet shows it (header is row 1). */
  rowNumber: number;
  data: Record<string, string>;
  /** Structural problems found by the CSV parser (wrong column count, bad quoting). */
  parseErrors?: string[];
}

/**
 * Decode and parse an uploaded CSV. File-level problems (wrong encoding,
 * missing or unknown columns, too large) throw a DomainError so no batch is
 * created; row-level problems are returned per row.
 */
export function parseCsv(bytes: Uint8Array, columns: readonly string[], required: readonly string[]): RawRow[] {
  if (bytes.byteLength === 0) throw new DomainError("The file is empty", "empty_file");
  if (bytes.byteLength > MAX_CSV_BYTES) throw new DomainError(`The file is larger than ${Math.floor(MAX_CSV_BYTES / 1_000_000)} MB. Split it into smaller files.`, "file_too_large");
  if (bytes.includes(0)) throw new DomainError("This does not look like a CSV text file", "not_text");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("The file is not UTF-8 encoded. Save it as 'CSV UTF-8' and try again.", "bad_encoding");
  }
  text = text.replace(/^﻿/, "");

  // Papaparse silently renames duplicate headers ("a" -> "a_1"), so check the raw header row first.
  const headRow = Papa.parse<string[]>(text, { preview: 1, header: false }).data[0] ?? [];
  const seen = new Set<string>();
  for (const h of headRow.map((c) => c.trim().toLowerCase())) {
    if (seen.has(h)) throw new DomainError(`Column "${h}" appears more than once`, "duplicate_column");
    seen.add(h);
  }

  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const header = res.meta.fields ?? [];
  if (header.length === 0) throw new DomainError("The file has no header row", "no_header");
  const unknown = header.filter((h) => !columns.includes(h));
  if (unknown.length) throw new DomainError(`Unknown column(s): ${unknown.join(", ")}. Expected: ${columns.join(", ")}`, "unknown_columns");
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) throw new DomainError(`Missing required column(s): ${missing.join(", ")}`, "missing_columns");
  if (res.data.length === 0) throw new DomainError("The file has a header but no data rows", "no_rows");
  if (res.data.length > MAX_CSV_ROWS) throw new DomainError(`The file has ${res.data.length} rows; the limit is ${MAX_CSV_ROWS}. Split it into smaller files.`, "too_many_rows");

  const errorsByRow = new Map<number, string[]>();
  for (const e of res.errors) {
    if (e.row === undefined || e.row === null) throw new DomainError(`The file could not be read as CSV: ${e.message}`, "unparseable");
    const list = errorsByRow.get(e.row) ?? [];
    list.push(e.message);
    errorsByRow.set(e.row, list);
  }

  return res.data.map((r, i) => {
    const data: Record<string, string> = {};
    for (const c of columns) {
      const v = r[c];
      data[c] = typeof v === "string" ? v.trim() : "";
    }
    const parseErrors = errorsByRow.get(i);
    return { rowNumber: i + 2, data, ...(parseErrors ? { parseErrors } : {}) };
  });
}

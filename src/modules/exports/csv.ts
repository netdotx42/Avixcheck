import { isDecimalString } from "@/lib/money/decimal";

/**
 * CSV writer that is safe to open in spreadsheet software.
 *
 * - Text cells that start with a formula trigger (`=`, `+`, `-`, `@`, tab, CR)
 *   are prefixed with a single quote so they are shown as text, not executed
 *   (OWASP "CSV injection"). Invoice content is untrusted, so every text
 *   column goes through this.
 * - Decimal columns are only written raw when they are plain decimal strings
 *   (so credit-note amounts like `-12.5000` stay numeric); anything else is
 *   treated as text and sanitised.
 * - Fields are quoted when they contain a delimiter, quote or newline (RFC 4180).
 */
export type CsvType = "text" | "decimal" | "int" | "date" | "datetime" | "bool";

export interface CsvColumn<T> {
  header: string;
  type: CsvType;
  value: (row: T) => unknown;
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function sanitizeText(v: string): string {
  return FORMULA_TRIGGER.test(v) ? `'${v}` : v;
}

function quote(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function csvCell(value: unknown, type: CsvType): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = type === "date" ? value.toISOString().slice(0, 10) : value.toISOString();
  else s = String(value);
  if (type === "decimal" || type === "int") {
    if (isDecimalString(s)) return s.trim();
    return quote(sanitizeText(s));
  }
  if (type === "bool") return value ? "true" : "false";
  return quote(sanitizeText(s));
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: Iterable<T>): string {
  const lines = [columns.map((c) => quote(sanitizeText(c.header))).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r), c.type)).join(","));
  // BOM so Excel detects UTF-8; CRLF line endings per RFC 4180.
  return `﻿${lines.join("\r\n")}\r\n`;
}

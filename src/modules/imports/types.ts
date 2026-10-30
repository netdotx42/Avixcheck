import type { Tx } from "@/db/client";
import type { RawRow } from "./csv";
import type { RowError } from "./fields";

export const IMPORT_KINDS = ["suppliers", "purchase_orders", "price_agreements", "approved_charges", "receipts"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export function isImportKind(v: unknown): v is ImportKind {
  return typeof v === "string" && (IMPORT_KINDS as readonly string[]).includes(v);
}

/**
 * What committing a row will do:
 * - create: new record
 * - update: existing record changed in place (version bumped; suppliers only)
 * - new_version: existing agreement/charge superseded by a new version
 * - add_line / update_line: PO amendment (PO snapshot kept in po_revisions)
 * - unchanged: identical to what is stored; nothing is written
 */
export type RowAction = "create" | "update" | "new_version" | "add_line" | "update_line" | "unchanged";

export interface RowResult {
  rowNumber: number;
  errors: RowError[];
  action: RowAction | null;
}

export interface ApplyCtx {
  orgId: string;
  userId: string;
  batchId: string;
  fileName: string;
}

export interface Plan {
  rows: RowResult[];
  /** Effects that are not rows, e.g. PO lines cancelled because they are absent from the file. */
  extra: Record<string, number>;
  /** Writes the plan. Only called inside the commit transaction when no row has errors. */
  apply(tx: Tx, ctx: ApplyCtx): Promise<void>;
}

export interface KindHandler {
  kind: ImportKind;
  label: string;
  columns: readonly string[];
  required: readonly string[];
  /**
   * Validate rows against the file itself and the organisation's current
   * reference data. `lock` is true at commit time: referenced rows are locked
   * FOR UPDATE so the plan cannot go stale before it is applied.
   */
  plan(tx: Tx, orgId: string, rows: RawRow[], opts: { lock: boolean }): Promise<Plan>;
}

export function newResults(rows: RawRow[]): Map<number, RowResult> {
  return new Map(
    rows.map((r) => [r.rowNumber, { rowNumber: r.rowNumber, errors: (r.parseErrors ?? []).map((m) => ({ message: m, source: "csv" as const })), action: null }]),
  );
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

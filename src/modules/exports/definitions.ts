import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { invoiceFilterSql } from "@/modules/reports/queries";
import type { ReportFilters } from "@/modules/reports/filters";
import type { CsvColumn } from "./csv";

/**
 * Export kinds. Each kind is a tenant-scoped query (run inside withTenant, so
 * RLS applies on top of the filters) plus the CSV column layout. Discrepancies
 * from superseded check runs are excluded, matching the reports.
 */
export const EXPORT_KINDS = ["invoices", "discrepancies", "exceptions"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_LABELS: Record<ExportKind, { label: string; description: string }> = {
  invoices: { label: "Invoices", description: "One row per invoice or credit note with status, totals and open exception count." },
  discrepancies: { label: "Discrepancies", description: "Every current discrepancy with expected vs actual values, amount and the rule and invoice versions used." },
  exceptions: { label: "Exceptions and decisions", description: "Exceptions with assignee, decision, reason and confirmed corrections (realised savings)." },
};

/** Hard cap so one export can't exhaust worker memory; narrow the filters for more. */
export const MAX_EXPORT_ROWS = 100_000;

type R = Record<string, unknown>;
const col = (header: string, type: CsvColumn<R>["type"], key: string): CsvColumn<R> => ({ header, type, value: (r) => r[key] });

const COLUMNS: Record<ExportKind, CsvColumn<R>[]> = {
  invoices: [
    col("invoice_id", "text", "id"),
    col("received_at", "datetime", "received_at"),
    col("document_type", "text", "kind"),
    col("status", "text", "status"),
    col("supplier_code", "text", "supplier_code"),
    col("supplier_name", "text", "supplier_name"),
    col("supplier_name_on_document", "text", "supplier_name_raw"),
    col("invoice_number", "text", "invoice_number"),
    col("invoice_date", "date", "invoice_date"),
    col("due_date", "date", "due_date"),
    col("po_number", "text", "po_number"),
    col("currency", "text", "currency"),
    col("subtotal", "decimal", "subtotal"),
    col("tax_total", "decimal", "tax_total"),
    col("total", "decimal", "total"),
    col("extraction_confidence", "decimal", "extraction_confidence"),
    col("open_exceptions", "int", "open_exceptions"),
    col("failure_reason", "text", "failure_reason"),
  ],
  discrepancies: [
    col("discrepancy_id", "text", "id"),
    col("invoice_id", "text", "invoice_id"),
    col("invoice_number", "text", "invoice_number"),
    col("supplier_code", "text", "supplier_code"),
    col("supplier_name", "text", "supplier_name"),
    col("invoice_line_no", "int", "line_no"),
    col("type", "text", "type"),
    col("severity", "text", "severity"),
    col("expected_value", "text", "expected_value"),
    col("actual_value", "text", "actual_value"),
    col("potential_exposure_amount", "decimal", "amount"),
    col("currency", "text", "currency"),
    col("explanation", "text", "explanation"),
    col("exception_status", "text", "exception_status"),
    col("check_run_id", "text", "check_run_id"),
    col("rule_set_version", "text", "rule_set_version"),
    col("invoice_revision_checked", "int", "invoice_revision"),
    col("detected_at", "datetime", "created_at"),
  ],
  exceptions: [
    col("exception_id", "text", "id"),
    col("invoice_id", "text", "invoice_id"),
    col("invoice_number", "text", "invoice_number"),
    col("supplier_code", "text", "supplier_code"),
    col("supplier_name", "text", "supplier_name"),
    col("kind", "text", "kind"),
    col("discrepancy_type", "text", "discrepancy_type"),
    col("title", "text", "title"),
    col("status", "text", "status"),
    col("assignee_email", "text", "assignee_email"),
    col("potential_exposure_amount", "decimal", "amount"),
    col("currency", "text", "currency"),
    col("decision_reason", "text", "decision_reason"),
    col("decided_by_email", "text", "decided_by_email"),
    col("decided_at", "datetime", "decided_at"),
    col("confirmed_correction_amount", "decimal", "confirmed_correction_amount"),
    col("confirmed_correction_ref", "text", "confirmed_correction_ref"),
    col("raised_at", "datetime", "created_at"),
  ],
};

export function exportColumns(kind: ExportKind) {
  return COLUMNS[kind];
}

/** Fetch rows for an export. Returns up to MAX_EXPORT_ROWS + 1 rows so callers can detect overflow. */
export async function exportRows(tx: Tx, kind: ExportKind, f: ReportFilters): Promise<R[]> {
  const limit = MAX_EXPORT_ROWS + 1;
  const where = invoiceFilterSql(f);
  let q;
  switch (kind) {
    case "invoices":
      q = sql`select i.id, i.created_at as received_at, i.kind::text as kind, i.status::text as status,
          s.code as supplier_code, s.name as supplier_name, i.supplier_name_raw, i.invoice_number,
          i.invoice_date::text as invoice_date, i.due_date::text as due_date, coalesce(po.po_number, i.po_number_raw) as po_number,
          i.currency, i.subtotal::text as subtotal, i.tax_total::text as tax_total, i.total::text as total,
          i.extraction_confidence::text as extraction_confidence,
          (select count(*)::int from exceptions e where e.invoice_id = i.id and e.status in ('open', 'in_review')) as open_exceptions,
          i.failure_reason
        from invoices i
        left join suppliers s on s.id = i.supplier_id
        left join purchase_orders po on po.id = i.purchase_order_id
        where ${where}
        order by i.created_at, i.id limit ${limit}`;
      break;
    case "discrepancies":
      q = sql`select d.id, d.invoice_id, i.invoice_number, s.code as supplier_code, s.name as supplier_name, il.line_no,
          d.type::text as type, d.severity, d.expected_value, d.actual_value, d.amount::text as amount, coalesce(d.currency, i.currency) as currency,
          d.explanation, e.status::text as exception_status, cr.id as check_run_id, cr.rule_set_version, cr.invoice_revision, d.created_at
        from discrepancies d
        join check_runs cr on cr.id = d.check_run_id
        join invoices i on i.id = d.invoice_id
        left join invoice_lines il on il.id = d.invoice_line_id
        left join suppliers s on s.id = i.supplier_id
        left join exceptions e on e.discrepancy_id = d.id
        where cr.status <> 'superseded' and ${where}
        order by d.created_at, d.id limit ${limit}`;
      break;
    case "exceptions":
      q = sql`select e.id, e.invoice_id, i.invoice_number, s.code as supplier_code, s.name as supplier_name,
          e.kind::text as kind, d.type::text as discrepancy_type, e.title, e.status::text as status,
          au.email as assignee_email, d.amount::text as amount, coalesce(d.currency, i.currency) as currency,
          e.decision_reason, du.email as decided_by_email, e.decided_at,
          e.confirmed_correction_amount::text as confirmed_correction_amount, e.confirmed_correction_ref, e.created_at
        from exceptions e
        join invoices i on i.id = e.invoice_id
        left join discrepancies d on d.id = e.discrepancy_id
        left join check_runs cr on cr.id = d.check_run_id
        left join suppliers s on s.id = i.supplier_id
        left join users au on au.id = e.assignee_user_id
        left join users du on du.id = e.decided_by
        where (cr.id is null or cr.status <> 'superseded') and ${where}
        order by e.created_at, e.id limit ${limit}`;
      break;
  }
  return (await tx.execute(q)).rows as R[];
}

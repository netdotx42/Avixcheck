import type { Tone } from "@/components/ui/status-badge";
import type { ExceptionStatus } from "./rules";

export const STATUS_TONE: Record<ExceptionStatus, Tone> = {
  open: "warn",
  in_review: "info",
  accepted_variance: "ok",
  correction_requested: "info",
  rejected_invoice: "danger",
  dismissed: "neutral",
};

export const TYPE_LABEL: Record<string, string> = {
  price_variance: "Price variance",
  quantity_excess: "Excess quantity",
  receipt_quantity_exceeded: "Above received quantity",
  duplicate_invoice: "Possible duplicate",
  missing_discount: "Missing discount",
  unapproved_charge: "Unapproved charge",
  arithmetic_error: "Arithmetic error",
  currency_mismatch: "Currency mismatch",
  unit_mismatch: "Unit mismatch",
  po_balance_exceeded: "PO balance exceeded",
  missing_reference: "Missing reference",
  conflicting_reference: "Conflicting reference",
  missing_data: "Missing data",
  extraction_review: "Extraction review",
  matching_review: "Matching review",
  processing_failure: "Processing failure",
};

export function typeLabel(type: string | null | undefined, kind: string): string {
  return TYPE_LABEL[type ?? kind] ?? (type ?? kind).replace(/_/g, " ");
}

export const SEVERITY_TONE: Record<string, Tone> = { high: "danger", medium: "warn", low: "info", info: "neutral" };

export const HISTORY_LABEL: Record<string, string> = {
  "exception.created": "Created",
  "exception.assigned": "Assignment changed",
  "exception.review_started": "Review started",
  "exception.decided": "Decision recorded",
  "exception.correction_confirmed": "Confirmed correction recorded",
};

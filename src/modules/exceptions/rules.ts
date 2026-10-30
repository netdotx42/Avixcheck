import type { Permission } from "@/lib/auth/permissions";

/**
 * Pure exception workflow rules: which decisions exist, who may take them,
 * which states they can be taken from, and how an invoice's status follows
 * from its exceptions. No database access here so it can be unit tested.
 */

export type ExceptionStatus = "open" | "in_review" | "accepted_variance" | "correction_requested" | "rejected_invoice" | "dismissed";
export type ExceptionKind = "discrepancy" | "extraction_review" | "matching_review" | "processing_failure";
export type Decision = "accept_variance" | "request_correction" | "reject_invoice" | "dismiss";

export const DECISION_STATUS: Record<Decision, ExceptionStatus> = {
  accept_variance: "accepted_variance",
  request_correction: "correction_requested",
  reject_invoice: "rejected_invoice",
  dismiss: "dismissed",
};

export const STATUS_LABEL: Record<ExceptionStatus, string> = {
  open: "Open",
  in_review: "In review",
  accepted_variance: "Variance accepted",
  correction_requested: "Correction requested",
  rejected_invoice: "Invoice rejected",
  dismissed: "Dismissed",
};

export const KIND_LABEL: Record<ExceptionKind, string> = {
  discrepancy: "Discrepancy",
  extraction_review: "Extraction review",
  matching_review: "Matching review",
  processing_failure: "Processing failure",
};

export const DECISION_LABEL: Record<Decision, string> = {
  accept_variance: "Accept variance",
  request_correction: "Request supplier correction",
  reject_invoice: "Reject invoice",
  dismiss: "Dismiss",
};

/** Statuses a decision can be made from. Decided exceptions are final. */
export const DECIDABLE: readonly ExceptionStatus[] = ["open", "in_review"];

export function isDecidable(status: ExceptionStatus): boolean {
  return DECIDABLE.includes(status);
}

/**
 * Unresolved = still needs someone. A requested supplier correction stays
 * unresolved until the confirmed correction (realised saving) is recorded.
 */
export function isUnresolved(e: { status: ExceptionStatus; confirmedCorrectionAmount: string | null }): boolean {
  if (e.status === "open" || e.status === "in_review") return true;
  return e.status === "correction_requested" && e.confirmedCorrectionAmount === null;
}

/** Decisions that make sense for a kind of exception. */
export function decisionsFor(kind: ExceptionKind): Decision[] {
  // Accepting a variance or asking the supplier to correct only applies to a
  // financial discrepancy. Review/failure exceptions are fixed upstream
  // (correction + re-check) or the invoice is rejected; dismissing them never
  // passes the invoice (see invoiceOutcome).
  if (kind === "discrepancy") return ["accept_variance", "request_correction", "reject_invoice", "dismiss"];
  return ["reject_invoice", "dismiss"];
}

/**
 * Permission needed for a decision. Accepting a variance is an Admin-only
 * financial authorisation; dismissing a discrepancy that carries exposure is
 * equivalent in effect (the invoice can pass), so it needs the same permission.
 */
export function permissionFor(decision: Decision, e: { kind: ExceptionKind; amount: string | null }): Permission {
  if (decision === "accept_variance") return "exception.accept_variance";
  if (decision === "dismiss" && e.kind === "discrepancy" && hasExposure(e.amount)) return "exception.accept_variance";
  return "exception.decide";
}

export function hasExposure(amount: string | null): boolean {
  return amount !== null && !/^[+-]?0*(\.0*)?$/.test(amount.trim());
}

/** Reason is mandatory for every decision except requesting a correction (where it is still recommended). */
export function reasonRequired(decision: Decision): boolean {
  return decision !== "request_correction";
}

export type InvoiceStatus =
  | "uploaded" | "scanning" | "quarantined" | "extracting" | "extraction_review" | "matching" | "matching_review"
  | "checking" | "exceptions_open" | "passed" | "failed" | "rejected";

/**
 * Invoice statuses whose value is driven by the review outcome of a completed
 * check run. "rejected" is deliberately absent: a rejection is never undone here.
 */
export const REVIEW_DRIVEN: readonly InvoiceStatus[] = ["exceptions_open", "passed"];

export interface OutcomeInput {
  invoiceStatus: InvoiceStatus;
  /** True when the invoice's latest check run completed (not running/failed/superseded). */
  hasCompletedCheckRun: boolean;
  /** Exceptions that still apply: excludes discrepancy exceptions from superseded runs. */
  exceptions: { kind: ExceptionKind; status: ExceptionStatus; confirmedCorrectionAmount: string | null }[];
}

/**
 * The invoice status implied by its exceptions, or null to leave it alone.
 * - Any "reject invoice" decision rejects the invoice, whatever stage it is in.
 * - Otherwise only invoices already through checks are touched: never pass an
 *   invoice that is still in extraction/matching review or has no completed run.
 * - Passed requires every applicable exception resolved. "Passed checks" is
 *   not payment approval.
 */
export function invoiceOutcome(input: OutcomeInput): InvoiceStatus | null {
  const { invoiceStatus, exceptions } = input;
  if (exceptions.some((e) => e.status === "rejected_invoice")) return invoiceStatus === "rejected" ? null : "rejected";
  if (!REVIEW_DRIVEN.includes(invoiceStatus) || !input.hasCompletedCheckRun) return null;
  const next: InvoiceStatus = exceptions.some(isUnresolved) ? "exceptions_open" : "passed";
  return next === invoiceStatus ? null : next;
}

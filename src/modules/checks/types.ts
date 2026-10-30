import type { OrgSettings } from "@/lib/org-settings";
import type { AgreementRef, MatchResult, PoLineRef, PoRef, SupplierRef } from "../matching/types";

/**
 * Plain-data input for the deterministic check engine. All money, prices and
 * quantities are decimal strings exactly as stored (NUMERIC). The service layer
 * loads this inside a locked transaction; the engine itself does no I/O.
 */
export interface CheckInput {
  settings: OrgSettings;
  invoice: {
    id: string;
    kind: "invoice" | "credit_note";
    invoiceNumber: string | null;
    invoiceDate: string | null;
    currency: string | null;
    subtotal: string | null;
    taxTotal: string | null;
    total: string | null;
    documentId: string;
    documentSha256: string | null;
  };
  lines: CheckLine[];
  match: MatchResult;
  supplier: SupplierRef | null;
  purchaseOrder: PoRef | null;
  poLines: PoLineState[];
  /** Sum of ACTIVE billings against the whole PO from OTHER invoices (credit notes negative). */
  poBilledAmountOther: string;
  /** Agreements referenced by line matches. */
  agreements: AgreementRef[];
  approvedCharges: ApprovedChargeRef[];
  /** Other invoices of the same organisation that could be duplicates. */
  duplicateCandidates: DuplicateCandidate[];
}

export interface CheckLine {
  id: string;
  lineNo: number;
  lineType: "goods" | "charge" | "discount";
  chargeType: string | null;
  sku: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string | null;
}

export interface PoLineState extends PoLineRef {
  /** Quantity billed by OTHER invoices' active billings (credit notes negative). */
  billedQuantityOther: string;
  /** Total received quantity, or null when no receipts exist for the line. */
  receivedQuantity: string | null;
  receiptIds: string[];
}

export interface ApprovedChargeRef {
  id: string;
  supplierId: string;
  chargeType: string;
  maxAmount: string | null;
  currency: string;
  validFrom: string;
  validTo: string | null;
}

export interface DuplicateCandidate {
  id: string;
  kind: "invoice" | "credit_note";
  supplierId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  total: string | null;
  documentId: string;
  documentSha256: string | null;
  status: string;
}

export type DiscrepancyType =
  | "price_variance"
  | "quantity_excess"
  | "receipt_quantity_exceeded"
  | "duplicate_invoice"
  | "missing_discount"
  | "unapproved_charge"
  | "arithmetic_error"
  | "currency_mismatch"
  | "unit_mismatch"
  | "po_balance_exceeded"
  | "missing_reference"
  | "conflicting_reference"
  | "missing_data";

export type Severity = "high" | "medium" | "low";

export interface Reference {
  type: "invoice" | "invoice_line" | "supplier" | "purchase_order" | "po_line" | "agreement" | "approved_charge" | "receipt" | "document";
  id: string;
  label: string;
  version?: number;
}

export interface Finding {
  type: DiscrepancyType;
  severity: Severity;
  /** Short title for the exception list. */
  title: string;
  invoiceLineId: string | null;
  lineNo: number | null;
  expectedValue: string | null;
  actualValue: string | null;
  /** Potential exposure in invoice currency (never realised savings). Null when it cannot be quantified. */
  amount: string | null;
  currency: string | null;
  explanation: string;
  references: Reference[];
}

/** Ledger row this invoice adds against a PO line (negative for credit notes). */
export interface Billing {
  invoiceLineId: string;
  poLineId: string;
  quantity: string;
  amount: string;
}

export interface CheckOutcome {
  findings: Finding[];
  billings: Billing[];
}

/**
 * Plain-data types for the deterministic matcher. Decimal values are strings
 * (NUMERIC from Postgres); the matcher never does money arithmetic.
 */

export type MatchStatus =
  /** Exactly one candidate at or above the org's confidence threshold. */
  | "matched"
  /** Exactly one candidate, but below the threshold: a person must confirm it. */
  | "low_confidence"
  /** Several equally good candidates, or two references that disagree. */
  | "conflicting"
  /** No candidate. */
  | "missing"
  /** Nothing to match (e.g. charge lines have no PO line; no SKU means no agreement). */
  | "not_applicable"
  /** Set by a person; trusted like an exact match. */
  | "manual";

export interface Candidate {
  id: string;
  label: string;
  confidence: string;
  method: string;
}

export interface RefMatch {
  status: MatchStatus;
  id: string | null;
  /** "1.0000" style string, null when nothing matched. */
  confidence: string | null;
  method: string | null;
  /** Human-readable reason, safe to show in the UI. */
  reason: string;
  candidates: Candidate[];
}

export interface LineMatch {
  invoiceLineId: string;
  lineNo: number;
  poLine: RefMatch;
  agreement: RefMatch;
}

export interface MatchResult {
  ruleSetVersion: string;
  /** Invoice revision this result belongs to; the check run refuses stale results. */
  revision: number;
  supplier: RefMatch;
  purchaseOrder: RefMatch;
  lines: LineMatch[];
  /** True when at least one reference is low-confidence (routes to matching review). */
  needsReview: boolean;
  matchedAt: string;
}

export interface SupplierRef {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  aliases: string[];
  currency: string | null;
  active: boolean;
  version: number;
}

export interface PoRef {
  id: string;
  supplierId: string;
  poNumber: string;
  currency: string;
  status: "open" | "closed" | "cancelled";
  version: number;
}

export interface PoLineRef {
  id: string;
  poId: string;
  lineNo: number;
  sku: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  cancelled: boolean;
}

export interface AgreementRef {
  id: string;
  supplierId: string;
  agreementRef: string;
  sku: string;
  unitPrice: string;
  currency: string;
  unit: string;
  discountPct: string;
  minQuantity: string | null;
  /** ISO date (YYYY-MM-DD). */
  validFrom: string;
  validTo: string | null;
  version: number;
  supersededAt: string | null;
}

export interface InvoiceHeaderInput {
  supplierId: string | null;
  supplierNameRaw: string | null;
  supplierTaxIdRaw: string | null;
  poNumberRaw: string | null;
  invoiceDate: string | null;
  currency: string | null;
}

export interface InvoiceLineInput {
  id: string;
  lineNo: number;
  lineType: "goods" | "charge" | "discount";
  sku: string | null;
  description: string | null;
  unit: string | null;
  unitPrice: string | null;
  poLineRef: string | null;
}

import type { Tone } from "@/components/ui/status-badge";
import type { AgreementState } from "./queries";
import type { ImportKind, RowAction } from "./types";

export const KIND_LABEL: Record<ImportKind, string> = {
  suppliers: "Suppliers",
  purchase_orders: "Purchase orders",
  price_agreements: "Price agreements",
  approved_charges: "Approved charges",
  receipts: "Goods receipts",
};

export const KIND_HELP: Record<ImportKind, string> = {
  suppliers: "Codes, names, tax IDs and the alternative names suppliers print on invoices. Existing codes are updated.",
  purchase_orders: "One row per PO line. A PO in the file is the complete PO: changes amend it and keep the earlier version; lines left out are cancelled.",
  price_agreements: "Dated unit prices per supplier, SKU and unit. Changes create a new version; overlapping periods are rejected as conflicting.",
  approved_charges: "Non-goods charges (freight, handling) a supplier may bill, with an optional cap per invoice.",
  receipts: "Goods received against PO lines. Receipt checks only run on lines that have receipts.",
};

export const ACTION_LABEL: Record<RowAction, string> = {
  create: "New",
  update: "Update",
  new_version: "New version",
  add_line: "Add line",
  update_line: "Amend line",
  unchanged: "No change",
};

export const ACTION_TONE: Record<RowAction, Tone> = {
  create: "info",
  update: "info",
  new_version: "info",
  add_line: "info",
  update_line: "info",
  unchanged: "neutral",
};

export const SUMMARY_LABEL: Record<string, string> = {
  rows: "Rows",
  errors: "Rows with errors",
  agreements_superseded: "Agreement rows superseded",
  charges_superseded: "Charge rows superseded",
  po_lines_cancelled: "PO lines cancelled",
  pos_amended: "POs amended",
  ...ACTION_LABEL,
};

export const BATCH_STATUS: Record<string, { tone: Tone; label: string }> = {
  previewed: { tone: "info", label: "Preview" },
  committing: { tone: "progress", label: "Committing" },
  committed: { tone: "ok", label: "Committed" },
  failed: { tone: "danger", label: "Failed" },
  discarded: { tone: "neutral", label: "Discarded" },
};

export const AGREEMENT_STATE: Record<AgreementState, { tone: Tone; label: string }> = {
  current: { tone: "ok", label: "Current" },
  upcoming: { tone: "info", label: "Upcoming" },
  expired: { tone: "neutral", label: "Expired" },
  superseded: { tone: "neutral", label: "Superseded" },
};

export const PO_STATUS: Record<string, { tone: Tone; label: string }> = {
  open: { tone: "ok", label: "Open" },
  closed: { tone: "neutral", label: "Closed" },
  cancelled: { tone: "danger", label: "Cancelled" },
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function param(v: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s.slice(0, 200) : undefined;
}

export function pick<T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(v as T) ? (v as T) : undefined;
}

/** Quantities stored as numeric(20,4): show without trailing zeros. */
export function formatQty(v: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const [i, f] = v.split(".");
  const frac = (f ?? "").replace(/0+$/, "");
  const sign = i!.startsWith("-") ? "−" : "";
  const grouped = i!.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${frac ? `.${frac}` : ""}`;
}

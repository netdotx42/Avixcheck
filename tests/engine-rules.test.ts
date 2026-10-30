import { describe, expect, it } from "vitest";
import { parseOrgSettings } from "../src/lib/org-settings";
import { evaluateInvoice } from "../src/modules/checks/rules";
import type { CheckInput, CheckLine, PoLineState } from "../src/modules/checks/types";
import type { LineMatch, MatchResult, RefMatch } from "../src/modules/matching/types";

const ok = (id: string): RefMatch => ({ status: "matched", id, confidence: "1.0000", method: "test", reason: "test", candidates: [] });
const na: RefMatch = { status: "not_applicable", id: null, confidence: null, method: null, reason: "n/a", candidates: [] };

function poLine(o: Partial<PoLineState> = {}): PoLineState {
  return { id: "pl1", poId: "po1", lineNo: 1, sku: "SKU1", description: "Widget", quantity: "100", unit: "each", unitPrice: "10.00", cancelled: false, billedQuantityOther: "0", receivedQuantity: null, receiptIds: [], ...o };
}
function goods(o: Partial<CheckLine> = {}): CheckLine {
  return { id: "il1", lineNo: 1, lineType: "goods", chargeType: null, sku: "SKU1", description: "Widget", quantity: "10", unit: "each", unitPrice: "10.00", amount: "100.00", ...o };
}

/** Builds a consistent input: lines map 1:1 to PO lines by the `poLineId` given in `links`. */
function build(o: {
  lines?: CheckLine[];
  links?: Record<string, { poLine?: string | null; agreement?: string | null }>;
  poLines?: PoLineState[];
  subtotal?: string | null;
  tax?: string | null;
  total?: string | null;
  kind?: "invoice" | "credit_note";
  currency?: string;
  poCurrency?: string;
  settings?: unknown;
  extra?: Partial<CheckInput>;
  match?: Partial<MatchResult>;
}): CheckInput {
  const lines = o.lines ?? [goods()];
  const links: Record<string, { poLine?: string | null; agreement?: string | null }> = o.links ?? Object.fromEntries(lines.filter((l) => l.lineType === "goods").map((l) => [l.id, { poLine: "pl1" }]));
  const lineMatches: LineMatch[] = lines.map((l) => ({
    invoiceLineId: l.id,
    lineNo: l.lineNo,
    poLine: l.lineType !== "goods" ? na : links[l.id]?.poLine ? ok(links[l.id]!.poLine!) : { ...na, status: "missing", reason: "no match" },
    agreement: links[l.id]?.agreement ? ok(links[l.id]!.agreement!) : na,
  }));
  const sub = o.subtotal === undefined ? lines.reduce((a, l) => a + (l.lineType === "discount" ? -1 : 1) * Number(l.amount ?? 0), 0).toFixed(2) : o.subtotal;
  const tax = o.tax === undefined ? "0.00" : o.tax;
  const total = o.total === undefined ? (sub === null ? null : (Number(sub) + Number(tax ?? 0)).toFixed(2)) : o.total;
  return {
    settings: parseOrgSettings(o.settings ?? {}),
    invoice: { id: "inv1", kind: o.kind ?? "invoice", invoiceNumber: "INV-1", invoiceDate: "2026-03-01", currency: o.currency ?? "GBP", subtotal: sub, taxTotal: tax, total, documentId: "doc1", documentSha256: "sha1" },
    lines,
    match: { ruleSetVersion: "t", revision: 1, supplier: ok("s1"), purchaseOrder: ok("po1"), lines: lineMatches, needsReview: false, matchedAt: "", ...o.match },
    supplier: { id: "s1", code: "S1", name: "Acme", taxId: null, aliases: [], currency: "GBP", active: true, version: 1 },
    purchaseOrder: { id: "po1", supplierId: "s1", poNumber: "PO-1", currency: o.poCurrency ?? "GBP", status: "open", version: 2 },
    poLines: o.poLines ?? [poLine()],
    poBilledAmountOther: "0",
    agreements: [],
    approvedCharges: [],
    duplicateCandidates: [],
    ...o.extra,
  };
}

const types = (input: CheckInput) => evaluateInvoice(input).findings.map((f) => f.type).sort();

describe("clean invoice", () => {
  it("produces no findings and bills the PO line", () => {
    const out = evaluateInvoice(build({}));
    expect(out.findings).toEqual([]);
    expect(out.billings).toEqual([{ invoiceLineId: "il1", poLineId: "pl1", quantity: "10.0000", amount: "100.0000" }]);
  });
});

describe("price variance and tolerance edges", () => {
  it("passes exactly at the absolute tolerance and flags just above it", () => {
    // default unit price tolerance: 0.01 absolute
    expect(types(build({ lines: [goods({ unitPrice: "10.01", amount: "100.10" })] }))).toEqual([]);
    const out = evaluateInvoice(build({ lines: [goods({ unitPrice: "10.011", amount: "100.11" })] }));
    expect(out.findings.map((f) => f.type)).toEqual(["price_variance"]);
    expect(out.findings[0]!.amount).toBe("0.1100");
    expect(out.findings[0]!.expectedValue).toBe("10.000000");
  });

  it("uses percentage tolerance when it is more lenient", () => {
    const settings = { tolerances: { unitPrice: { absolute: "0", percent: "1" } } };
    expect(types(build({ settings, lines: [goods({ unitPrice: "10.10", amount: "101.00" })] }))).toEqual([]);
    expect(types(build({ settings, lines: [goods({ unitPrice: "10.11", amount: "101.10" })] }))).toEqual(["price_variance"]);
  });

  it("prefers the agreement price over the PO price", () => {
    const input = build({ lines: [goods({ unitPrice: "10.00", amount: "100.00" })], links: { il1: { poLine: "pl1", agreement: "a1" } } });
    input.agreements = [{ id: "a1", supplierId: "s1", agreementRef: "AG-1", sku: "SKU1", unitPrice: "9.50", currency: "GBP", unit: "each", discountPct: "0", minQuantity: null, validFrom: "2026-01-01", validTo: null, version: 3, supersededAt: null }];
    const f = evaluateInvoice(input).findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: "price_variance", expectedValue: "9.500000", amount: "5.0000" });
    expect(f[0]!.references.find((r) => r.type === "agreement")).toMatchObject({ id: "a1", version: 3 });
  });

  it("does not flag favourable prices", () => {
    expect(types(build({ lines: [goods({ unitPrice: "9.00", amount: "90.00" })] }))).toEqual([]);
  });
});

describe("missing discount", () => {
  const agreement = (o = {}) => ({ id: "a1", supplierId: "s1", agreementRef: "AG-1", sku: "SKU1", unitPrice: "10.00", currency: "GBP", unit: "each", discountPct: "5", minQuantity: "10", validFrom: "2026-01-01", validTo: null, version: 1, supersededAt: null, ...o });
  it("flags list price billed when the volume discount applies", () => {
    const input = build({ links: { il1: { poLine: "pl1", agreement: "a1" } } });
    input.agreements = [agreement()];
    const f = evaluateInvoice(input).findings;
    expect(f.map((x) => x.type)).toEqual(["missing_discount"]);
    expect(f[0]).toMatchObject({ expectedValue: "9.500000", amount: "5.0000" });
  });
  it("does not apply below the minimum quantity", () => {
    const input = build({ lines: [goods({ quantity: "9", amount: "90.00" })], links: { il1: { poLine: "pl1", agreement: "a1" } } });
    input.agreements = [agreement()];
    expect(types(input)).toEqual([]);
  });
  it("is covered by a separate discount line", () => {
    const lines = [goods(), { ...goods({ id: "il2", lineNo: 2, lineType: "discount", sku: null, quantity: null, unitPrice: null, amount: "5.00" }) }];
    const input = build({ lines, links: { il1: { poLine: "pl1", agreement: "a1" } } });
    input.agreements = [agreement()];
    expect(types(input)).toEqual([]);
  });
});

describe("arithmetic and rounding", () => {
  it("flags a line amount that is not quantity × price", () => {
    const f = evaluateInvoice(build({ lines: [goods({ amount: "100.05" })] })).findings;
    expect(f.map((x) => x.type)).toEqual(["arithmetic_error"]);
    expect(f[0]).toMatchObject({ expectedValue: "100.0000", actualValue: "100.0500", amount: "0.0500" });
  });

  it("applies the organisation's rounding mode", () => {
    // 3 × 0.125 = 0.375 → half_up 0.38, half_even 0.38, down 0.37
    const line = goods({ quantity: "3", unitPrice: "0.125", amount: "0.37" });
    const strict = { tolerances: { lineAmount: { absolute: "0", percent: "0" }, unitPrice: { absolute: "1", percent: "0" } } };
    expect(types(build({ lines: [line], settings: { ...strict, rounding: { mode: "down" } } }))).toEqual([]);
    expect(types(build({ lines: [line], settings: { ...strict, rounding: { mode: "half_up" } } }))).toContain("arithmetic_error");
  });

  it("rounds per line or on the total depending on settings", () => {
    // 3 lines of 1 × 0.333 → per line 0.33 × 3 = 0.99; on total round(0.999) = 1.00
    const lines = [1, 2, 3].map((n) => goods({ id: `il${n}`, lineNo: n, quantity: "1", unitPrice: "0.333", amount: "0.33" }));
    const links = Object.fromEntries(lines.map((l) => [l.id, { poLine: null }]));
    const strict = { tolerances: { invoiceTotal: { absolute: "0", percent: "0" } } };
    expect(types(build({ lines, links, subtotal: "0.99", match: { purchaseOrder: na }, settings: { ...strict, rounding: { roundPerLine: true } } }))).toEqual([]);
    expect(types(build({ lines, links, subtotal: "0.99", match: { purchaseOrder: na }, settings: { ...strict, rounding: { roundPerLine: false } } }))).toEqual(["arithmetic_error"]);
  });

  it("checks lines sum to subtotal and subtotal + tax = total", () => {
    expect(types(build({ subtotal: "110.00", total: "110.00" }))).toEqual(["arithmetic_error"]);
    expect(types(build({ tax: "20.00", total: "121.00" }))).toEqual(["arithmetic_error"]);
    expect(types(build({ tax: "20.00", total: "120.05" }))).toEqual([]); // within 0.05 total tolerance
  });
});

describe("quantities, partial billing and receipts", () => {
  it("allows partial invoices up to the PO line balance", () => {
    expect(types(build({ poLines: [poLine({ billedQuantityOther: "90" })] }))).toEqual([]);
  });

  it("flags quantity above the remaining PO line balance", () => {
    const f = evaluateInvoice(build({ poLines: [poLine({ billedQuantityOther: "95" })] })).findings;
    expect(f.map((x) => x.type)).toEqual(["quantity_excess"]);
    expect(f[0]).toMatchObject({ expectedValue: "5.0000", actualValue: "10.0000", amount: "50.0000" });
  });

  it("accumulates two invoice lines billing the same PO line", () => {
    const lines = [goods({ quantity: "60", amount: "600.00" }), goods({ id: "il2", lineNo: 2, quantity: "60", amount: "600.00" })];
    const f = evaluateInvoice(build({ lines, links: { il1: { poLine: "pl1" }, il2: { poLine: "pl1" } } })).findings;
    expect(f.map((x) => [x.type, x.lineNo])).toEqual([["quantity_excess", 2]]);
    expect(f[0]!.amount).toBe("200.0000");
  });

  it("checks receipts only when receipt data exists, without double counting PO excess", () => {
    expect(types(build({ poLines: [poLine({ receivedQuantity: null })] }))).toEqual([]);
    const f = evaluateInvoice(build({ poLines: [poLine({ receivedQuantity: "4", receiptIds: ["r1"] })] })).findings;
    expect(f.map((x) => x.type)).toEqual(["receipt_quantity_exceeded"]);
    expect(f[0]!.amount).toBe("60.0000");
    const both = evaluateInvoice(build({ poLines: [poLine({ billedQuantityOther: "95", receivedQuantity: "96", receiptIds: ["r1"] })] })).findings;
    // PO excess 5 (50.00); receipt excess 9, of which 4 is extra (40.00)
    expect(both.map((x) => [x.type, x.amount])).toEqual([
      ["quantity_excess", "50.0000"],
      ["receipt_quantity_exceeded", "40.0000"],
    ]);
  });

  it("flags cumulative PO value overage not explained by line findings", () => {
    // Two PO lines worth 1000 total; 950 already billed elsewhere on line 2; this invoice bills 100 on line 1.
    const lines2 = [poLine(), poLine({ id: "pl2", lineNo: 2, quantity: "1", unitPrice: "0.00" })];
    const input = build({ poLines: lines2 });
    input.poBilledAmountOther = "950.00";
    const f = evaluateInvoice(input).findings;
    expect(f.map((x) => x.type)).toEqual(["po_balance_exceeded"]);
    expect(f[0]).toMatchObject({ expectedValue: "50.0000", actualValue: "100.0000", amount: "50.0000" });
  });

  it("does not double count PO overage already explained by a price variance", () => {
    const input = build({ lines: [goods({ quantity: "100", unitPrice: "11.00", amount: "1100.00" })] });
    const f = evaluateInvoice(input).findings;
    expect(f.map((x) => x.type)).toEqual(["price_variance"]);
  });
});

describe("credit notes", () => {
  it("produce negative billings and skip excess checks", () => {
    const out = evaluateInvoice(build({ kind: "credit_note", lines: [goods({ quantity: "-10", amount: "-100.00" })], subtotal: "-100.00", total: "-100.00", poLines: [poLine({ billedQuantityOther: "100" })] }));
    expect(out.findings).toEqual([]);
    expect(out.billings[0]).toMatchObject({ quantity: "-10.0000", amount: "-100.0000" });
  });
  it("flag an under-credit", () => {
    const f = evaluateInvoice(build({ kind: "credit_note", lines: [goods({ unitPrice: "9.00", amount: "90.00" })] })).findings;
    expect(f.map((x) => [x.type, x.amount])).toEqual([["price_variance", "10.0000"]]);
  });
});

describe("currency and unit", () => {
  it("flags a currency mismatch and does not compare prices across currencies", () => {
    expect(types(build({ currency: "EUR", lines: [goods({ unitPrice: "20.00", amount: "200.00" })] }))).toEqual(["currency_mismatch"]);
  });
  it("flags a unit mismatch and skips price/quantity checks for the line", () => {
    const out = evaluateInvoice(build({ lines: [goods({ unit: "box", unitPrice: "100.00", amount: "1000.00" })] }));
    expect(out.findings.map((f) => f.type)).toEqual(["unit_mismatch"]);
    expect(out.billings).toEqual([]);
  });
  it("treats unit synonyms as equal", () => {
    expect(types(build({ lines: [goods({ unit: "EA" })] }))).toEqual([]);
  });
});

describe("charges", () => {
  const charge = (amount: string): CheckLine => ({ id: "c1", lineNo: 2, lineType: "charge", chargeType: "Freight", sku: null, description: "Freight", quantity: null, unit: null, unitPrice: null, amount });
  it("flags charges with no approval, and above the approved maximum", () => {
    const lines = [goods(), charge("25.00")];
    expect(types(build({ lines }))).toEqual(["unapproved_charge"]);
    const input = build({ lines });
    input.approvedCharges = [{ id: "ac1", supplierId: "s1", chargeType: "freight", maxAmount: "20.00", currency: "GBP", validFrom: "2026-01-01", validTo: null }];
    const f = evaluateInvoice(input).findings;
    expect(f.map((x) => [x.type, x.amount])).toEqual([["unapproved_charge", "5.0000"]]);
    input.approvedCharges[0]!.maxAmount = "25.00";
    expect(types(input)).toEqual([]);
    input.approvedCharges[0]!.validTo = "2026-02-01";
    expect(types(input)).toEqual(["unapproved_charge"]);
  });
});

describe("duplicates", () => {
  const cand = (o = {}) => ({ id: "inv0", kind: "invoice" as const, supplierId: "s1", invoiceNumber: "inv 1", invoiceDate: "2026-01-01", total: "999.00", documentId: "doc0", documentSha256: "sha0", status: "passed", ...o });
  it("detects same supplier + number, same total + date, and same document", () => {
    expect(types(build({ extra: { duplicateCandidates: [cand()] } }))).toEqual(["duplicate_invoice"]);
    const fuzzy = evaluateInvoice(build({ extra: { duplicateCandidates: [cand({ invoiceNumber: "OTHER", invoiceDate: "2026-03-01", total: "100.00" })] } })).findings;
    expect(fuzzy[0]).toMatchObject({ type: "duplicate_invoice", severity: "medium", amount: "100.0000" });
    expect(types(build({ extra: { duplicateCandidates: [cand({ supplierId: "s9", invoiceNumber: "X", documentSha256: "sha1" })] } }))).toEqual(["duplicate_invoice"]);
  });
  it("ignores rejected invoices and other suppliers", () => {
    expect(types(build({ extra: { duplicateCandidates: [cand({ status: "rejected" }), cand({ id: "x", supplierId: "s2" })] } }))).toEqual([]);
  });
});

describe("references and missing data", () => {
  it("never passes an invoice with missing header data or unmatched references", () => {
    const missing = build({ total: null });
    missing.invoice.invoiceNumber = null;
    expect(types(missing)).toContain("missing_data");
    expect(types(build({ match: { purchaseOrder: { ...na, status: "missing", reason: "PO not found" } } }))).toEqual(["missing_reference"]);
    expect(types(build({ match: { supplier: { ...na, status: "conflicting", reason: "two suppliers" } } }))).toEqual(["conflicting_reference"]);
    expect(types(build({ links: { il1: { poLine: null } } }))).toEqual(["missing_reference"]);
  });
  it("flags lines missing quantity or price", () => {
    expect(types(build({ lines: [goods({ quantity: null })], subtotal: "100.00" }))).toEqual(["missing_data"]);
  });
  it("flags billing against a cancelled PO line or a closed PO", () => {
    expect(types(build({ poLines: [poLine({ cancelled: true })] }))).toEqual(["conflicting_reference"]);
    const closed = build({});
    closed.purchaseOrder!.status = "closed";
    expect(types(closed)).toEqual(["conflicting_reference"]);
  });
});

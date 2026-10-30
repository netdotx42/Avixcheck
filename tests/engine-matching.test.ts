import { describe, expect, it } from "vitest";
import { matchInvoice, matchLineToPoLine, resolveAgreement, resolveSupplier } from "../src/modules/matching/match";
import { normUnit, parseLineRef, similarity } from "../src/modules/matching/normalize";
import type { AgreementRef, InvoiceHeaderInput, InvoiceLineInput, PoLineRef, PoRef, SupplierRef } from "../src/modules/matching/types";

const sup = (id: string, o: Partial<SupplierRef> = {}): SupplierRef => ({ id, code: id.toUpperCase(), name: `Supplier ${id}`, taxId: null, aliases: [], currency: "GBP", active: true, version: 1, ...o });
const header = (o: Partial<InvoiceHeaderInput> = {}): InvoiceHeaderInput => ({ supplierId: null, supplierNameRaw: null, supplierTaxIdRaw: null, poNumberRaw: null, invoiceDate: "2026-03-01", currency: "GBP", ...o });
const po = (id: string, supplierId: string, poNumber: string, o: Partial<PoRef> = {}): PoRef => ({ id, supplierId, poNumber, currency: "GBP", status: "open", version: 1, ...o });
const pl = (id: string, poId: string, lineNo: number, o: Partial<PoLineRef> = {}): PoLineRef => ({ id, poId, lineNo, sku: null, description: `Item ${lineNo}`, quantity: "10", unit: "each", unitPrice: "5.00", cancelled: false, ...o });
const line = (id: string, lineNo: number, o: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({ id, lineNo, lineType: "goods", sku: null, description: null, unit: null, unitPrice: null, poLineRef: null, ...o });
const agr = (id: string, o: Partial<AgreementRef> = {}): AgreementRef => ({ id, supplierId: "s1", agreementRef: `AG-${id}`, sku: "SKU1", unitPrice: "5.00", currency: "GBP", unit: "each", discountPct: "0", minQuantity: null, validFrom: "2026-01-01", validTo: "2026-12-31", version: 1, supersededAt: null, ...o });

describe("normalisation", () => {
  it("normalises units, line refs and names", () => {
    expect(normUnit("EA.")).toBe("each");
    expect(normUnit("pcs")).toBe("each");
    expect(normUnit("Kg")).toBe("kg");
    expect(parseLineRef("PO-1001/3")).toBe(3);
    expect(parseLineRef("L02")).toBe(2);
    expect(parseLineRef("")).toBeNull();
    expect(similarity("ACME Ltd", "Acme Limited")).toBe(1);
    expect(similarity("Acme Supplies", "Acme Suplies")).toBeGreaterThan(0.8);
  });
});

describe("supplier resolution", () => {
  const list = [sup("s1", { taxId: "GB123456789", name: "Acme Supplies Ltd", aliases: ["ACME UK"] }), sup("s2", { name: "Beta Parts" }), sup("s3", { name: "Beta Parts", code: "BP2" })];

  it("prefers tax id", () => {
    const r = resolveSupplier(header({ supplierTaxIdRaw: "gb 123 456 789", supplierNameRaw: "Something else" }), list);
    expect(r).toMatchObject({ status: "matched", id: "s1", method: "tax_id", confidence: "1.0000" });
  });

  it("flags a tax id contradicted by an exact name of another supplier", () => {
    const r = resolveSupplier(header({ supplierTaxIdRaw: "GB123456789", supplierNameRaw: "Beta Parts" }), [list[0]!, list[1]!]);
    expect(r.status).toBe("conflicting");
  });

  it("matches by name and alias ignoring legal suffixes", () => {
    expect(resolveSupplier(header({ supplierNameRaw: "ACME SUPPLIES LIMITED" }), list)).toMatchObject({ status: "matched", id: "s1", method: "name" });
    expect(resolveSupplier(header({ supplierNameRaw: "Acme UK" }), list)).toMatchObject({ status: "matched", id: "s1", method: "alias" });
  });

  it("reports duplicates as conflicting and unknowns as missing", () => {
    expect(resolveSupplier(header({ supplierNameRaw: "Beta Parts" }), list).status).toBe("conflicting");
    expect(resolveSupplier(header({ supplierNameRaw: "Nobody" }), list).status).toBe("missing");
    expect(resolveSupplier(header(), list).status).toBe("missing");
  });

  it("gives fuzzy name matches a lower confidence", () => {
    const r = resolveSupplier(header({ supplierNameRaw: "Acme Suplies" }), list);
    expect(r.status).toBe("matched");
    expect(Number(r.confidence)).toBeLessThan(0.9);
  });
});

describe("full match", () => {
  const suppliers = [sup("s1", { name: "Acme" }), sup("s2", { name: "Other" })];
  const pos = [po("p1", "s1", "PO-1001"), po("p2", "s2", "PO-2002")];
  const lines = [pl("l1", "p1", 1, { sku: "SKU1" }), pl("l2", "p1", 2, { sku: "SKU2", description: "Blue widgets" }), pl("l3", "p1", 3, { sku: "SKU3", cancelled: true })];
  const base = { revision: 1, suppliers, purchaseOrders: pos, poLines: lines, agreements: [agr("a1")], minConfidence: "0.90" };

  it("matches PO, lines and the dated agreement", () => {
    const r = matchInvoice({ ...base, header: header({ supplierNameRaw: "Acme", poNumberRaw: "po 1001" }), lines: [line("i1", 1, { sku: "sku1" }), line("i2", 2, { poLineRef: "2" })] });
    expect(r.needsReview).toBe(false);
    expect(r.purchaseOrder).toMatchObject({ status: "matched", id: "p1" });
    expect(r.lines[0]!.poLine).toMatchObject({ status: "matched", id: "l1", method: "sku" });
    expect(r.lines[0]!.agreement).toMatchObject({ status: "matched", id: "a1" });
    expect(r.lines[1]!.poLine).toMatchObject({ status: "matched", id: "l2", method: "po_line_ref" });
  });

  it("takes the supplier from the PO and detects PO/supplier conflicts", () => {
    expect(matchInvoice({ ...base, header: header({ poNumberRaw: "PO-1001" }), lines: [] }).supplier).toMatchObject({ status: "matched", id: "s1", method: "purchase_order" });
    const r = matchInvoice({ ...base, header: header({ supplierNameRaw: "Other", poNumberRaw: "PO-1001" }), lines: [] });
    expect(r.supplier.status).toBe("conflicting");
    expect(r.purchaseOrder.status).toBe("conflicting");
  });

  it("routes a guessed PO (no number on invoice) to review", () => {
    const r = matchInvoice({ ...base, header: header({ supplierNameRaw: "Acme" }), lines: [] });
    expect(r.purchaseOrder.status).toBe("low_confidence");
    expect(r.needsReview).toBe(true);
  });

  it("flags a line reference that disagrees with the SKU", () => {
    const m = matchLineToPoLine(line("i", 1, { poLineRef: "1", sku: "SKU2" }), pos[0]!, lines);
    expect(m.status).toBe("conflicting");
  });

  it("does not match cancelled lines by SKU and marks unknown SKUs missing", () => {
    expect(matchLineToPoLine(line("i", 1, { sku: "SKU3" }), pos[0]!, lines).status).toBe("missing");
    expect(matchLineToPoLine(line("i", 1, { sku: "NOPE" }), pos[0]!, lines).status).toBe("missing");
  });

  it("treats a SKU repeated on several PO lines as conflicting unless the price disambiguates", () => {
    const dup = [pl("d1", "p1", 1, { sku: "X", unitPrice: "1.00" }), pl("d2", "p1", 2, { sku: "X", unitPrice: "2.00" })];
    expect(matchLineToPoLine(line("i", 1, { sku: "X" }), pos[0]!, dup).status).toBe("conflicting");
    expect(matchLineToPoLine(line("i", 1, { sku: "X", unitPrice: "2.000000" }), pos[0]!, dup)).toMatchObject({ status: "matched", id: "d2" });
  });

  it("matches by description and routes weak description matches to review", () => {
    const r = matchInvoice({ ...base, header: header({ poNumberRaw: "PO-1001" }), lines: [line("i1", 1, { description: "Blue widgets" }), line("i2", 2, { description: "Blue widget s" })] });
    expect(r.lines[0]!.poLine).toMatchObject({ status: "matched", id: "l2", method: "description" });
    expect(r.lines[1]!.poLine.status).toBe("low_confidence");
    expect(r.needsReview).toBe(true);
  });

  it("does not match charge lines to PO lines", () => {
    expect(matchLineToPoLine(line("i", 1, { lineType: "charge" }), pos[0]!, lines).status).toBe("not_applicable");
  });
});

describe("agreement selection", () => {
  const goods = line("i", 1, { sku: "SKU1", unit: "ea" });
  it("uses the agreement valid on the invoice date (inclusive bounds)", () => {
    const list = [agr("old", { validFrom: "2025-01-01", validTo: "2025-12-31", unitPrice: "4.00" }), agr("new", { validFrom: "2026-01-01", validTo: null })];
    expect(resolveAgreement(goods, "s1", null, "2025-12-31", list).id).toBe("old");
    expect(resolveAgreement(goods, "s1", null, "2026-01-01", list).id).toBe("new");
    expect(resolveAgreement(goods, "s1", null, "2024-06-01", list).status).toBe("missing");
  });
  it("ignores superseded versions and flags overlapping agreements with different prices", () => {
    expect(resolveAgreement(goods, "s1", null, "2026-03-01", [agr("a", { supersededAt: "2026-02-01T00:00:00Z", unitPrice: "9" }), agr("b")]).id).toBe("b");
    expect(resolveAgreement(goods, "s1", null, "2026-03-01", [agr("a"), agr("b", { unitPrice: "5.50", agreementRef: "AG-X" })]).status).toBe("conflicting");
  });
  it("needs a date and a supplier, and respects the unit", () => {
    expect(resolveAgreement(goods, "s1", null, null, [agr("a")]).status).toBe("missing");
    expect(resolveAgreement(goods, null, null, "2026-03-01", [agr("a")]).status).toBe("missing");
    expect(resolveAgreement(line("i", 1, { sku: "SKU1", unit: "box" }), "s1", null, "2026-03-01", [agr("a")]).status).toBe("missing");
  });
});

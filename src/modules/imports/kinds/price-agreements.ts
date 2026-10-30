import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { priceAgreements } from "@/db/schema";
import { code, currency, decimal, decEq, isoDate, optionalDecimal, optionalIsoDate, optionalText, rangesOverlap, text, validateRow, type RowError } from "../fields";
import { chunk, newResults, type KindHandler } from "../types";
import { fmtRange, inactiveSupplier, loadSuppliersByCode, unknownSupplier } from "./shared";

const columns = ["agreement_ref", "supplier_code", "sku", "description", "unit_price", "currency", "unit", "discount_pct", "min_quantity", "valid_from", "valid_to"] as const;

const rowSchema = z
  .object({
    agreement_ref: code(),
    supplier_code: code(),
    sku: text(100),
    description: optionalText(500),
    unit_price: decimal({ scale: 6, min: "0" }),
    currency: currency(),
    unit: text(32),
    discount_pct: optionalDecimal({ scale: 4, precision: 9, min: "0", max: "100", maxExclusive: true }).transform((v) => v ?? "0"),
    min_quantity: optionalDecimal({ scale: 4, min: "0", minExclusive: true }),
    valid_from: isoDate(),
    valid_to: optionalIsoDate(),
  })
  .superRefine((r, ctx) => {
    if (r.valid_to !== null && r.valid_to < r.valid_from) ctx.addIssue({ code: "custom", path: ["valid_to"], message: "valid_to is before valid_from" });
  });
type Row = z.infer<typeof rowSchema>;
type Existing = typeof priceAgreements.$inferSelect;

/** An agreement line: one SKU+unit under one agreement reference. The file's rows for a line replace all its active rows. */
const lineKey = (supplierId: string, ref: string, sku: string, unit: string) => JSON.stringify([supplierId, ref, sku, unit]);
/** Agreements for the same supplier, SKU and unit must not overlap in time, whatever their reference. */
const priceKey = (supplierId: string, sku: string, unit: string) => JSON.stringify([supplierId, sku, unit]);

function sameTerms(a: Existing, r: Row) {
  return (
    a.validFrom === r.valid_from &&
    (a.validTo ?? null) === r.valid_to &&
    decEq(a.unitPrice, r.unit_price) &&
    a.currency === r.currency &&
    decEq(a.discountPct, r.discount_pct) &&
    decEq(a.minQuantity, r.min_quantity) &&
    (a.description ?? null) === r.description
  );
}

export const priceAgreementsImport: KindHandler = {
  kind: "price_agreements",
  label: "Price agreements",
  columns,
  required: ["agreement_ref", "supplier_code", "sku", "unit_price", "currency", "unit", "valid_from"],
  async plan(tx, orgId, raw, { lock }) {
    const results = newResults(raw);
    const parsed: { rowNumber: number; row: Row }[] = [];
    for (const r of raw) {
      const res = results.get(r.rowNumber)!;
      const { value, errors } = validateRow(rowSchema, r.data);
      res.errors.push(...errors);
      if (value && res.errors.length === 0) parsed.push({ rowNumber: r.rowNumber, row: value });
    }

    const supplierMap = await loadSuppliersByCode(tx, orgId, parsed.map((p) => p.row.supplier_code));
    const valid: { rowNumber: number; row: Row; supplierId: string }[] = [];
    for (const p of parsed) {
      const s = supplierMap.get(p.row.supplier_code);
      const res = results.get(p.rowNumber)!;
      if (!s) res.errors.push(unknownSupplier(p.row.supplier_code));
      else if (!s.active) res.errors.push(inactiveSupplier(p.row.supplier_code));
      else valid.push({ ...p, supplierId: s.id });
    }

    // Active (non-superseded) agreements for every supplier+sku+unit touched by the file.
    const supplierIds = [...new Set(valid.map((v) => v.supplierId))];
    const skus = [...new Set(valid.map((v) => v.row.sku))];
    const active: Existing[] = [];
    for (const part of chunk(skus, 1000)) {
      if (supplierIds.length === 0) break;
      const q = tx
        .select()
        .from(priceAgreements)
        .where(and(eq(priceAgreements.orgId, orgId), inArray(priceAgreements.supplierId, supplierIds), inArray(priceAgreements.sku, part), isNull(priceAgreements.supersededAt)));
      active.push(...(await (lock ? q.for("update") : q)));
    }
    const maxVersion = new Map<string, number>();
    if (valid.length) {
      const refs = [...new Set(valid.map((v) => v.row.agreement_ref))];
      for (const part of chunk(refs, 1000)) {
        const rows = await tx
          .select({ supplierId: priceAgreements.supplierId, ref: priceAgreements.agreementRef, sku: priceAgreements.sku, unit: priceAgreements.unit, v: sql<number>`max(${priceAgreements.version})::int` })
          .from(priceAgreements)
          .where(and(eq(priceAgreements.orgId, orgId), inArray(priceAgreements.supplierId, supplierIds), inArray(priceAgreements.agreementRef, part)))
          .groupBy(priceAgreements.supplierId, priceAgreements.agreementRef, priceAgreements.sku, priceAgreements.unit);
        for (const r of rows) maxVersion.set(lineKey(r.supplierId, r.ref, r.sku, r.unit), r.v);
      }
    }

    // Group file rows by agreement line.
    const groups = new Map<string, typeof valid>();
    for (const v of valid) {
      const k = lineKey(v.supplierId, v.row.agreement_ref, v.row.sku, v.row.unit);
      groups.set(k, [...(groups.get(k) ?? []), v]);
    }
    const replacedLines = new Set(groups.keys());

    // Conflicts: overlapping validity for the same supplier+sku+unit, within the
    // file or against active agreements the file does not replace.
    const candidates = new Map<string, { label: string; from: string; to: string | null; rowNumber?: number }[]>();
    for (const a of active) {
      if (replacedLines.has(lineKey(a.supplierId, a.agreementRef, a.sku, a.unit))) continue;
      const k = priceKey(a.supplierId, a.sku, a.unit);
      candidates.set(k, [...(candidates.get(k) ?? []), { label: `existing agreement ${a.agreementRef} v${a.version}`, from: a.validFrom, to: a.validTo }]);
    }
    for (const v of valid) {
      const k = priceKey(v.supplierId, v.row.sku, v.row.unit);
      const res = results.get(v.rowNumber)!;
      const errs: RowError[] = [];
      for (const c of candidates.get(k) ?? []) {
        if (rangesOverlap(v.row.valid_from, v.row.valid_to, c.from, c.to)) {
          errs.push({ field: "valid_from", message: `Conflicting agreement: overlaps ${c.label} (${fmtRange(c.from, c.to)}) for SKU ${v.row.sku} / ${v.row.unit}` });
        }
      }
      res.errors.push(...errs);
      candidates.set(k, [...(candidates.get(k) ?? []), { label: `row ${v.rowNumber}`, from: v.row.valid_from, to: v.row.valid_to, rowNumber: v.rowNumber }]);
    }

    const inserts: (typeof priceAgreements.$inferInsert)[] = [];
    const supersede: string[] = [];
    for (const [k, rows] of groups) {
      if (rows.some((r) => results.get(r.rowNumber)!.errors.length > 0)) continue;
      const current = active.filter((a) => lineKey(a.supplierId, a.agreementRef, a.sku, a.unit) === k);
      const unchanged =
        current.length === rows.length && rows.every((r) => current.some((a) => sameTerms(a, r.row))) && current.every((a) => rows.some((r) => sameTerms(a, r.row)));
      const everExisted = maxVersion.has(k);
      for (const r of rows) results.get(r.rowNumber)!.action = unchanged ? "unchanged" : everExisted ? "new_version" : "create";
      if (unchanged) continue;
      const version = (maxVersion.get(k) ?? 0) + 1;
      supersede.push(...current.map((a) => a.id));
      for (const { row, supplierId } of rows) {
        inserts.push({
          orgId,
          supplierId,
          agreementRef: row.agreement_ref,
          sku: row.sku,
          description: row.description,
          unitPrice: row.unit_price,
          currency: row.currency,
          unit: row.unit,
          discountPct: row.discount_pct,
          minQuantity: row.min_quantity,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          version,
        });
      }
    }

    return {
      rows: [...results.values()],
      extra: { agreements_superseded: supersede.length },
      async apply(tx2) {
        const now = new Date();
        for (const part of chunk(supersede, 1000)) {
          await tx2.update(priceAgreements).set({ supersededAt: now }).where(and(inArray(priceAgreements.id, part), isNull(priceAgreements.supersededAt)));
        }
        for (const part of chunk(inserts, 500)) await tx2.insert(priceAgreements).values(part);
      },
    };
  },
};

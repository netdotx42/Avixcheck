import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { approvedCharges } from "@/db/schema";
import { code, currency, decEq, isoDate, optionalDecimal, optionalIsoDate, rangesOverlap, validateRow } from "../fields";
import { chunk, newResults, type KindHandler } from "../types";
import { fmtRange, inactiveSupplier, loadSuppliersByCode, unknownSupplier } from "./shared";

const columns = ["supplier_code", "charge_type", "max_amount", "currency", "valid_from", "valid_to"] as const;

const rowSchema = z
  .object({
    supplier_code: code(),
    /** Normalised to lower case so "Freight" on an invoice matches "freight" here. */
    charge_type: code(64).transform((v) => v.toLowerCase()),
    max_amount: optionalDecimal({ scale: 4, min: "0" }),
    currency: currency(),
    valid_from: isoDate(),
    valid_to: optionalIsoDate(),
  })
  .superRefine((r, ctx) => {
    if (r.valid_to !== null && r.valid_to < r.valid_from) ctx.addIssue({ code: "custom", path: ["valid_to"], message: "valid_to is before valid_from" });
  });
type Row = z.infer<typeof rowSchema>;
type Existing = typeof approvedCharges.$inferSelect;

/** A charge line is supplier + charge type + currency. The file's rows for a line replace its active rows. */
const lineKey = (supplierId: string, type: string, cur: string) => JSON.stringify([supplierId, type, cur]);

const sameTerms = (a: Existing, r: Row) => a.validFrom === r.valid_from && (a.validTo ?? null) === r.valid_to && decEq(a.maxAmount, r.max_amount);

export const approvedChargesImport: KindHandler = {
  kind: "approved_charges",
  label: "Approved charges",
  columns,
  required: ["supplier_code", "charge_type", "currency", "valid_from"],
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
    const groups = new Map<string, { rowNumber: number; row: Row; supplierId: string }[]>();
    for (const p of parsed) {
      const s = supplierMap.get(p.row.supplier_code);
      const res = results.get(p.rowNumber)!;
      if (!s) res.errors.push(unknownSupplier(p.row.supplier_code));
      else if (!s.active) res.errors.push(inactiveSupplier(p.row.supplier_code));
      else {
        const k = lineKey(s.id, p.row.charge_type, p.row.currency);
        const g = groups.get(k) ?? [];
        for (const other of g) {
          if (rangesOverlap(p.row.valid_from, p.row.valid_to, other.row.valid_from, other.row.valid_to)) {
            res.errors.push({ field: "valid_from", message: `Conflicting charge: overlaps row ${other.rowNumber} (${fmtRange(other.row.valid_from, other.row.valid_to)})` });
          }
        }
        g.push({ ...p, supplierId: s.id });
        groups.set(k, g);
      }
    }

    const supplierIds = [...new Set([...groups.values()].flat().map((v) => v.supplierId))];
    const active: Existing[] = [];
    const maxVersion = new Map<string, number>();
    for (const part of chunk(supplierIds, 1000)) {
      const q = tx.select().from(approvedCharges).where(and(eq(approvedCharges.orgId, orgId), inArray(approvedCharges.supplierId, part), isNull(approvedCharges.supersededAt)));
      active.push(...(await (lock ? q.for("update") : q)));
      const vs = await tx
        .select({ supplierId: approvedCharges.supplierId, t: approvedCharges.chargeType, c: approvedCharges.currency, v: sql<number>`max(${approvedCharges.version})::int` })
        .from(approvedCharges)
        .where(and(eq(approvedCharges.orgId, orgId), inArray(approvedCharges.supplierId, part)))
        .groupBy(approvedCharges.supplierId, approvedCharges.chargeType, approvedCharges.currency);
      for (const v of vs) maxVersion.set(lineKey(v.supplierId, v.t, v.c), v.v);
    }

    const inserts: (typeof approvedCharges.$inferInsert)[] = [];
    const supersede: string[] = [];
    for (const [k, rows] of groups) {
      if (rows.some((r) => results.get(r.rowNumber)!.errors.length > 0)) continue;
      const current = active.filter((a) => lineKey(a.supplierId, a.chargeType, a.currency) === k);
      const unchanged =
        current.length === rows.length && rows.every((r) => current.some((a) => sameTerms(a, r.row))) && current.every((a) => rows.some((r) => sameTerms(a, r.row)));
      for (const r of rows) results.get(r.rowNumber)!.action = unchanged ? "unchanged" : maxVersion.has(k) ? "new_version" : "create";
      if (unchanged) continue;
      const version = (maxVersion.get(k) ?? 0) + 1;
      supersede.push(...current.map((a) => a.id));
      for (const { row, supplierId } of rows) {
        inserts.push({ orgId, supplierId, chargeType: row.charge_type, maxAmount: row.max_amount, currency: row.currency, validFrom: row.valid_from, validTo: row.valid_to, version });
      }
    }

    return {
      rows: [...results.values()],
      extra: { charges_superseded: supersede.length },
      async apply(tx2) {
        const now = new Date();
        for (const part of chunk(supersede, 1000)) {
          await tx2.update(approvedCharges).set({ supersededAt: now }).where(and(inArray(approvedCharges.id, part), isNull(approvedCharges.supersededAt)));
        }
        for (const part of chunk(inserts, 500)) await tx2.insert(approvedCharges).values(part);
      },
    };
  },
};

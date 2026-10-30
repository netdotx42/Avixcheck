import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { poLineBillings, poLines, poRevisions, purchaseOrders } from "@/db/schema";
import { dec } from "@/lib/money/decimal";
import { code, currency, decimal, decEq, optionalIsoDate, optionalText, positiveInt, text, validateRow } from "../fields";
import { chunk, newResults, type KindHandler, type RowResult } from "../types";
import { inactiveSupplier, loadSuppliersByCode, unknownSupplier } from "./shared";

const columns = ["po_number", "supplier_code", "currency", "issued_on", "line_no", "sku", "description", "quantity", "unit", "unit_price"] as const;

const rowSchema = z.object({
  po_number: code(),
  supplier_code: code(),
  currency: currency(),
  issued_on: optionalIsoDate(),
  line_no: positiveInt(),
  sku: optionalText(100),
  description: text(500),
  quantity: decimal({ scale: 4, min: "0", minExclusive: true }),
  unit: text(32),
  unit_price: decimal({ scale: 6, min: "0" }),
});
type Row = z.infer<typeof rowSchema>;
type Item = { rowNumber: number; row: Row };
type PoRow = typeof purchaseOrders.$inferSelect;
type LineRow = typeof poLines.$inferSelect;

const sameLine = (l: LineRow, r: Row) =>
  !l.cancelled && (l.sku ?? null) === r.sku && l.description === r.description && decEq(l.quantity, r.quantity) && l.unit === r.unit && decEq(l.unitPrice, r.unit_price);

interface PoPlan {
  kind: "create" | "amend";
  po?: PoRow;
  supplierId: string;
  head: Row;
  items: Item[];
  updateLines: { id: string; row: Row }[];
  addLines: Row[];
  cancelLines: string[];
  lines?: LineRow[];
}

/**
 * One CSV row per PO line; header columns repeat on every row. A PO in the file
 * is the complete PO: re-importing a changed PO amends it (snapshot to
 * po_revisions, version + 1). Lines missing from the file are marked cancelled,
 * never deleted, so billings and receipts keep their references.
 */
export const purchaseOrdersImport: KindHandler = {
  kind: "purchase_orders",
  label: "Purchase orders",
  columns,
  required: ["po_number", "supplier_code", "currency", "line_no", "description", "quantity", "unit", "unit_price"],
  async plan(tx, orgId, raw, { lock }) {
    const results = newResults(raw);
    const groups = new Map<string, Item[]>();
    for (const r of raw) {
      const res = results.get(r.rowNumber)!;
      const { value, errors } = validateRow(rowSchema, r.data);
      res.errors.push(...errors);
      if (!value) continue;
      groups.set(value.po_number, [...(groups.get(value.po_number) ?? []), { rowNumber: r.rowNumber, row: value }]);
    }

    // Header consistency and duplicate lines within each PO.
    for (const items of groups.values()) {
      const head = items[0]!.row;
      const seen = new Map<number, number>();
      for (const it of items) {
        const res = results.get(it.rowNumber)!;
        if (it.row.supplier_code !== head.supplier_code) res.errors.push({ field: "supplier_code", message: `Differs from the first row of ${head.po_number} (row ${items[0]!.rowNumber})` });
        if (it.row.currency !== head.currency) res.errors.push({ field: "currency", message: `Differs from the first row of ${head.po_number} (row ${items[0]!.rowNumber})` });
        if (it.row.issued_on !== head.issued_on) res.errors.push({ field: "issued_on", message: `Differs from the first row of ${head.po_number} (row ${items[0]!.rowNumber})` });
        const dup = seen.get(it.row.line_no);
        if (dup !== undefined) res.errors.push({ field: "line_no", message: `Duplicate line ${it.row.line_no} for ${head.po_number}; also on row ${dup}` });
        else seen.set(it.row.line_no, it.rowNumber);
      }
    }

    const supplierMap = await loadSuppliersByCode(tx, orgId, [...groups.values()].map((g) => g[0]!.row.supplier_code));
    const numbers = [...groups.keys()];
    const existingPos = new Map<string, PoRow>();
    for (const part of chunk(numbers, 1000)) {
      const q = tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.orgId, orgId), inArray(purchaseOrders.poNumber, part)));
      for (const p of await (lock ? q.for("update") : q)) existingPos.set(p.poNumber, p);
    }
    const poIds = [...existingPos.values()].map((p) => p.id);
    const linesByPo = new Map<string, LineRow[]>();
    const billedByLine = new Map<string, string>();
    for (const part of chunk(poIds, 1000)) {
      const q = tx.select().from(poLines).where(and(eq(poLines.orgId, orgId), inArray(poLines.poId, part)));
      const lines = await (lock ? q.for("update") : q);
      for (const l of lines) linesByPo.set(l.poId, [...(linesByPo.get(l.poId) ?? []), l]);
      const lineIds = lines.map((l) => l.id);
      for (const lp of chunk(lineIds, 1000)) {
        const billed = await tx
          .select({ poLineId: poLineBillings.poLineId, qty: sql<string>`coalesce(sum(${poLineBillings.quantity}), 0)::text` })
          .from(poLineBillings)
          .where(and(eq(poLineBillings.orgId, orgId), eq(poLineBillings.active, true), inArray(poLineBillings.poLineId, lp)))
          .groupBy(poLineBillings.poLineId);
        for (const b of billed) billedByLine.set(b.poLineId, b.qty);
      }
    }

    const plans: PoPlan[] = [];
    let cancelledCount = 0;
    for (const [number, items] of groups) {
      const head = items[0]!.row;
      const firstRes = results.get(items[0]!.rowNumber)!;
      const s = supplierMap.get(head.supplier_code);
      if (!s) {
        firstRes.errors.push(unknownSupplier(head.supplier_code));
        continue;
      }
      const po = existingPos.get(number);
      if (!po) {
        if (!s.active) firstRes.errors.push(inactiveSupplier(head.supplier_code));
        if (items.some((i) => results.get(i.rowNumber)!.errors.length)) continue;
        for (const it of items) results.get(it.rowNumber)!.action = "create";
        plans.push({ kind: "create", supplierId: s.id, head, items, updateLines: [], addLines: items.map((i) => i.row), cancelLines: [] });
        continue;
      }

      // Amendment of an existing PO.
      if (po.supplierId !== s.id) firstRes.errors.push({ field: "supplier_code", message: `${number} already exists for a different supplier; a PO's supplier cannot change` });
      if (po.currency !== head.currency) firstRes.errors.push({ field: "currency", message: `${number} is in ${po.currency}; a PO's currency cannot change` });
      if (po.status !== "open") firstRes.errors.push({ field: "po_number", message: `${number} is ${po.status} and cannot be amended` });
      const lines = linesByPo.get(po.id) ?? [];
      const byNo = new Map(lines.map((l) => [l.lineNo, l]));
      const plan: PoPlan = { kind: "amend", po, supplierId: s.id, head, items, updateLines: [], addLines: [], cancelLines: [], lines };
      for (const it of items) {
        const res: RowResult = results.get(it.rowNumber)!;
        const cur = byNo.get(it.row.line_no);
        if (!cur) {
          res.action = "add_line";
          plan.addLines.push(it.row);
          continue;
        }
        const billed = billedByLine.get(cur.id);
        if (billed && dec(it.row.quantity).lt(dec(billed))) {
          res.errors.push({ field: "quantity", message: `Quantity ${it.row.quantity} is below the ${dec(billed).toFixed()} already billed on line ${cur.lineNo}` });
        }
        if (cur.unit !== it.row.unit && billed && !dec(billed).isZero()) {
          res.errors.push({ field: "unit", message: `Line ${cur.lineNo} has billings in "${cur.unit}"; its unit cannot change` });
        }
        if (sameLine(cur, it.row)) res.action = "unchanged";
        else {
          res.action = "update_line";
          plan.updateLines.push({ id: cur.id, row: it.row });
        }
      }
      const inFile = new Set(items.map((i) => i.row.line_no));
      plan.cancelLines = lines.filter((l) => !l.cancelled && !inFile.has(l.lineNo)).map((l) => l.id);
      if (items.some((i) => results.get(i.rowNumber)!.errors.length)) continue;
      const headerChanged = (po.issuedOn ?? null) !== head.issued_on;
      if (!headerChanged && plan.updateLines.length === 0 && plan.addLines.length === 0 && plan.cancelLines.length === 0) continue;
      cancelledCount += plan.cancelLines.length;
      plans.push(plan);
    }

    return {
      rows: [...results.values()],
      extra: { po_lines_cancelled: cancelledCount, pos_amended: plans.filter((p) => p.kind === "amend").length },
      async apply(tx2, ctx) {
        for (const p of plans) {
          let poId: string;
          if (p.kind === "create") {
            const [created] = await tx2
              .insert(purchaseOrders)
              .values({ orgId, supplierId: p.supplierId, poNumber: p.head.po_number, currency: p.head.currency, issuedOn: p.head.issued_on })
              .returning({ id: purchaseOrders.id });
            poId = created!.id;
          } else {
            const po = p.po!;
            poId = po.id;
            await tx2.insert(poRevisions).values({
              orgId,
              poId,
              version: po.version,
              snapshot: { header: po, lines: p.lines },
              reason: `Amended by CSV import "${ctx.fileName}" (batch ${ctx.batchId})`,
              createdBy: ctx.userId,
            });
            await tx2
              .update(purchaseOrders)
              .set({ issuedOn: p.head.issued_on, version: po.version + 1, updatedAt: new Date() })
              .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.version, po.version)));
            for (const u of p.updateLines) {
              await tx2
                .update(poLines)
                .set({ sku: u.row.sku, description: u.row.description, quantity: u.row.quantity, unit: u.row.unit, unitPrice: u.row.unit_price, cancelled: false, updatedAt: new Date() })
                .where(eq(poLines.id, u.id));
            }
            if (p.cancelLines.length) await tx2.update(poLines).set({ cancelled: true, updatedAt: new Date() }).where(inArray(poLines.id, p.cancelLines));
          }
          for (const part of chunk(p.addLines, 500)) {
            await tx2.insert(poLines).values(
              part.map((r) => ({ orgId, poId, lineNo: r.line_no, sku: r.sku, description: r.description, quantity: r.quantity, unit: r.unit, unitPrice: r.unit_price })),
            );
          }
        }
      },
    };
  },
};

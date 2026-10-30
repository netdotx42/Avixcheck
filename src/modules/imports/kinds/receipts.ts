import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { poLines, purchaseOrders, receipts } from "@/db/schema";
import { dec } from "@/lib/money/decimal";
import { code, decimal, decEq, isoDate, positiveInt, validateRow } from "../fields";
import { chunk, newResults, type KindHandler } from "../types";

const columns = ["receipt_ref", "po_number", "line_no", "quantity", "received_on"] as const;

const rowSchema = z.object({
  receipt_ref: code(),
  po_number: code(),
  line_no: positiveInt(),
  quantity: decimal({ scale: 4, min: "0", minExclusive: true }),
  received_on: isoDate(),
});
type Row = z.infer<typeof rowSchema>;

/** Goods receipts are facts: re-importing an identical receipt is a no-op, a different one is an error. */
export const receiptsImport: KindHandler = {
  kind: "receipts",
  label: "Goods receipts",
  columns,
  required: [...columns],
  async plan(tx, orgId, raw, { lock }) {
    const results = newResults(raw);
    const parsed: { rowNumber: number; row: Row }[] = [];
    const seen = new Map<string, number>();
    for (const r of raw) {
      const res = results.get(r.rowNumber)!;
      const { value, errors } = validateRow(rowSchema, r.data);
      res.errors.push(...errors);
      if (!value || res.errors.length) continue;
      const k = JSON.stringify([value.receipt_ref, value.po_number, value.line_no]);
      const dup = seen.get(k);
      if (dup !== undefined) {
        res.errors.push({ field: "receipt_ref", message: `Duplicate receipt for this PO line; also on row ${dup}` });
        continue;
      }
      seen.set(k, r.rowNumber);
      parsed.push({ rowNumber: r.rowNumber, row: value });
    }

    const pos = new Map<string, { id: string; status: string }>();
    for (const part of chunk([...new Set(parsed.map((p) => p.row.po_number))], 1000)) {
      const q = tx.select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, status: purchaseOrders.status }).from(purchaseOrders).where(and(eq(purchaseOrders.orgId, orgId), inArray(purchaseOrders.poNumber, part)));
      for (const p of await (lock ? q.for("share") : q)) pos.set(p.poNumber, p);
    }
    const lines = new Map<string, { id: string; cancelled: boolean }>();
    for (const part of chunk([...pos.values()].map((p) => p.id), 1000)) {
      const q = tx.select({ id: poLines.id, poId: poLines.poId, lineNo: poLines.lineNo, cancelled: poLines.cancelled }).from(poLines).where(and(eq(poLines.orgId, orgId), inArray(poLines.poId, part)));
      for (const l of await (lock ? q.for("share") : q)) lines.set(`${l.poId}:${l.lineNo}`, l);
    }
    const existing = new Map<string, typeof receipts.$inferSelect>();
    for (const part of chunk([...lines.values()].map((l) => l.id), 1000)) {
      const rows = await tx.select().from(receipts).where(and(eq(receipts.orgId, orgId), inArray(receipts.poLineId, part)));
      for (const r of rows) existing.set(`${r.receiptRef}:${r.poLineId}`, r);
    }

    const inserts: (typeof receipts.$inferInsert)[] = [];
    for (const { rowNumber, row } of parsed) {
      const res = results.get(rowNumber)!;
      const po = pos.get(row.po_number);
      if (!po) {
        res.errors.push({ field: "po_number", message: `Unknown PO "${row.po_number}". Import the purchase order first.` });
        continue;
      }
      const line = lines.get(`${po.id}:${row.line_no}`);
      if (!line) {
        res.errors.push({ field: "line_no", message: `${row.po_number} has no line ${row.line_no}` });
        continue;
      }
      if (line.cancelled) {
        res.errors.push({ field: "line_no", message: `${row.po_number} line ${row.line_no} is cancelled` });
        continue;
      }
      const cur = existing.get(`${row.receipt_ref}:${line.id}`);
      if (cur) {
        if (decEq(cur.quantity, row.quantity) && cur.receivedOn === row.received_on) res.action = "unchanged";
        else res.errors.push({ field: "receipt_ref", message: `Receipt ${row.receipt_ref} is already recorded for this line with quantity ${dec(cur.quantity).toFixed()} on ${cur.receivedOn}; receipts cannot be changed by import` });
        continue;
      }
      res.action = "create";
      inserts.push({ orgId, poLineId: line.id, receiptRef: row.receipt_ref, quantity: row.quantity, receivedOn: row.received_on });
    }

    return {
      rows: [...results.values()],
      extra: {},
      async apply(tx2) {
        for (const part of chunk(inserts, 500)) await tx2.insert(receipts).values(part);
      },
    };
  },
};

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { suppliers } from "@/db/schema";
import { code, optionalCurrency, optionalText, text, validateRow } from "../fields";
import { chunk, newResults, type KindHandler } from "../types";

const columns = ["supplier_code", "name", "tax_id", "currency", "aliases"] as const;

const rowSchema = z.object({
  supplier_code: code(),
  name: text(200),
  tax_id: optionalText(64),
  currency: optionalCurrency(),
  aliases: z
    .string()
    .max(2000, "At most 2000 characters")
    .transform((v) => [...new Set(v.split(";").map((a) => a.trim()).filter(Boolean))]),
});
type Row = z.infer<typeof rowSchema>;

export const suppliersImport: KindHandler = {
  kind: "suppliers",
  label: "Suppliers",
  columns,
  required: ["supplier_code", "name"],
  async plan(tx, orgId, raw, { lock }) {
    const results = newResults(raw);
    const valid: { rowNumber: number; row: Row }[] = [];
    const firstRowByCode = new Map<string, number>();
    for (const r of raw) {
      const res = results.get(r.rowNumber)!;
      const { value, errors } = validateRow(rowSchema, r.data);
      res.errors.push(...errors);
      if (!value) continue;
      const key = value.supplier_code.toLowerCase();
      const first = firstRowByCode.get(key);
      if (first !== undefined) {
        res.errors.push({ field: "supplier_code", message: `Duplicate supplier_code; also on row ${first}` });
        continue;
      }
      firstRowByCode.set(key, r.rowNumber);
      if (res.errors.length === 0) valid.push({ rowNumber: r.rowNumber, row: value });
    }

    const codes = valid.map((v) => v.row.supplier_code);
    const existing = new Map<string, typeof suppliers.$inferSelect>();
    for (const part of chunk(codes, 1000)) {
      const q = tx.select().from(suppliers).where(and(eq(suppliers.orgId, orgId), inArray(suppliers.code, part)));
      for (const s of await (lock ? q.for("update") : q)) existing.set(s.code, s);
    }

    const creates: Row[] = [];
    const updates: { id: string; row: Row }[] = [];
    for (const { rowNumber, row } of valid) {
      const res = results.get(rowNumber)!;
      const cur = existing.get(row.supplier_code);
      if (!cur) {
        res.action = "create";
        creates.push(row);
        continue;
      }
      const same =
        cur.name === row.name &&
        (cur.taxId ?? null) === row.tax_id &&
        (cur.currency ?? null) === row.currency &&
        JSON.stringify(cur.aliases) === JSON.stringify(row.aliases);
      res.action = same ? "unchanged" : "update";
      if (!same) updates.push({ id: cur.id, row });
    }

    return {
      rows: [...results.values()],
      extra: {},
      async apply(tx2) {
        for (const part of chunk(creates, 500)) {
          await tx2.insert(suppliers).values(part.map((r) => ({ orgId, code: r.supplier_code, name: r.name, taxId: r.tax_id, currency: r.currency, aliases: r.aliases })));
        }
        for (const u of updates) {
          await tx2
            .update(suppliers)
            .set({ name: u.row.name, taxId: u.row.tax_id, currency: u.row.currency, aliases: u.row.aliases, version: sql`${suppliers.version} + 1`, updatedAt: new Date() })
            .where(eq(suppliers.id, u.id));
        }
      },
    };
  },
};

import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { suppliers } from "@/db/schema";
import { chunk } from "../types";

export async function loadSuppliersByCode(tx: Tx, orgId: string, codes: string[]) {
  const map = new Map<string, { id: string; active: boolean }>();
  for (const part of chunk([...new Set(codes)], 1000)) {
    const rows = await tx.select({ id: suppliers.id, code: suppliers.code, active: suppliers.active }).from(suppliers).where(and(eq(suppliers.orgId, orgId), inArray(suppliers.code, part)));
    for (const s of rows) map.set(s.code, { id: s.id, active: s.active });
  }
  return map;
}

export function unknownSupplier(code: string) {
  return { field: "supplier_code", message: `Unknown supplier_code "${code}". Import the supplier first.` };
}

export function inactiveSupplier(code: string) {
  return { field: "supplier_code", message: `Supplier "${code}" is inactive` };
}

export const fmtRange = (from: string, to: string | null) => `${from} to ${to ?? "open-ended"}`;

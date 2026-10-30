import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { poLineBillings, poLines } from "@/db/schema";
import { audit } from "@/lib/audit";

/**
 * PO balances come from the `po_line_billings` ledger. Only ACTIVE rows count:
 * a newer check run of the same invoice deactivates the rows of the run it
 * supersedes, and rejecting an invoice releases its rows. Credit notes add
 * negative rows. Sums are done in SQL NUMERIC and returned as strings.
 */
export async function activeBilledByPoLine(tx: Tx, poLineIds: string[], excludeInvoiceId?: string) {
  const out = new Map<string, { quantity: string; amount: string }>();
  if (!poLineIds.length) return out;
  const conds = [inArray(poLineBillings.poLineId, poLineIds), eq(poLineBillings.active, true)];
  if (excludeInvoiceId) conds.push(ne(poLineBillings.invoiceId, excludeInvoiceId));
  const rows = await tx
    .select({ poLineId: poLineBillings.poLineId, quantity: sql<string>`sum(${poLineBillings.quantity})::text`, amount: sql<string>`sum(${poLineBillings.amount})::text` })
    .from(poLineBillings)
    .where(and(...conds))
    .groupBy(poLineBillings.poLineId);
  for (const r of rows) out.set(r.poLineId, { quantity: r.quantity, amount: r.amount });
  return out;
}

export interface PoLineBalance {
  poLineId: string;
  lineNo: number;
  ordered: string;
  billed: string;
  remaining: string;
  billedAmount: string;
}

/** Ordered vs billed vs remaining quantity per PO line (for the PO detail page). */
export async function poBalances(tx: Tx, poId: string): Promise<PoLineBalance[]> {
  const res = await tx.execute(sql`
    select l.id, l.line_no, l.quantity::text as ordered,
      coalesce(sum(b.quantity) filter (where b.active), 0)::text as billed,
      (l.quantity - coalesce(sum(b.quantity) filter (where b.active), 0))::text as remaining,
      coalesce(sum(b.amount) filter (where b.active), 0)::text as billed_amount
    from ${poLines} l left join ${poLineBillings} b on b.po_line_id = l.id
    where l.po_id = ${poId}
    group by l.id, l.line_no, l.quantity
    order by l.line_no`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    poLineId: r.id as string,
    lineNo: r.line_no as number,
    ordered: r.ordered as string,
    billed: r.billed as string,
    remaining: r.remaining as string,
    billedAmount: r.billed_amount as string,
  }));
}

/**
 * Stop an invoice's billings counting toward PO balances (e.g. the invoice was
 * rejected). Call in the same transaction as the decision.
 */
export async function releaseInvoiceBillings(tx: Tx, a: { orgId: string; invoiceId: string; actorUserId: string | null; reason: string }) {
  const released = await tx
    .update(poLineBillings)
    .set({ active: false })
    .where(and(eq(poLineBillings.invoiceId, a.invoiceId), eq(poLineBillings.active, true)))
    .returning({ id: poLineBillings.id });
  if (released.length) {
    await audit(tx, { orgId: a.orgId, actorUserId: a.actorUserId, action: "invoice.billings_released", entityType: "invoice", entityId: a.invoiceId, data: { count: released.length, reason: a.reason } });
  }
  return released.length;
}

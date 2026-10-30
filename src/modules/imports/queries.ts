import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Tx } from "@/db/client";
import { inSequence } from "@/db/tenant";
import { approvedCharges, importBatches, importRows, poLineBillings, poLines, poRevisions, priceAgreements, purchaseOrders, receipts, suppliers, users } from "@/db/schema";
import { dec } from "@/lib/money/decimal";

/** Read models for the Suppliers & Agreements and Purchase Orders pages. Always called inside withTenant(). */

export const PAGE_SIZE = 25;

/** Escape LIKE wildcards in user search input. */
export function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function listSuppliers(tx: Tx, f: { q?: string; status?: "active" | "inactive"; page: number }) {
  const where: SQL[] = [];
  if (f.q) where.push(or(ilike(suppliers.code, likeTerm(f.q)), ilike(suppliers.name, likeTerm(f.q)), ilike(suppliers.taxId, likeTerm(f.q)), sql`array_to_string(${suppliers.aliases}, ' ') ilike ${likeTerm(f.q)}`)!);
  if (f.status) where.push(eq(suppliers.active, f.status === "active"));
  const cond = where.length ? and(...where) : undefined;
  const [{ n }] = (await tx.select({ n: count() }).from(suppliers).where(cond)) as [{ n: number }];
  const rows = await tx
    .select({
      id: suppliers.id,
      code: suppliers.code,
      name: suppliers.name,
      taxId: suppliers.taxId,
      currency: suppliers.currency,
      active: suppliers.active,
      version: suppliers.version,
      updatedAt: suppliers.updatedAt,
      agreements: sql<number>`(select count(*)::int from price_agreements a where a.supplier_id = ${suppliers.id} and a.superseded_at is null)`,
      openPos: sql<number>`(select count(*)::int from purchase_orders p where p.supplier_id = ${suppliers.id} and p.status = 'open')`,
    })
    .from(suppliers)
    .where(cond)
    .orderBy(asc(suppliers.code))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  return { rows, total: n };
}

export type AgreementState = "current" | "upcoming" | "expired" | "superseded";

export function agreementState(a: { validFrom: string; validTo: string | null; supersededAt: Date | null }, on = today()): AgreementState {
  if (a.supersededAt) return "superseded";
  if (a.validFrom > on) return "upcoming";
  if (a.validTo !== null && a.validTo < on) return "expired";
  return "current";
}

function stateCond(state: AgreementState | undefined, t: { validFrom: AnyPgColumn; validTo: AnyPgColumn; supersededAt: AnyPgColumn }) {
  const d = today();
  switch (state) {
    case "superseded":
      return isNotNull(t.supersededAt);
    case "upcoming":
      return and(isNull(t.supersededAt), sql`${t.validFrom} > ${d}`);
    case "expired":
      return and(isNull(t.supersededAt), sql`${t.validTo} < ${d}`);
    case "current":
      return and(isNull(t.supersededAt), sql`${t.validFrom} <= ${d}`, or(isNull(t.validTo), sql`${t.validTo} >= ${d}`));
    default:
      // Default view hides superseded versions; they stay visible on the supplier page.
      return isNull(t.supersededAt);
  }
}

export async function listAgreements(tx: Tx, f: { q?: string; state?: AgreementState | "all"; supplierId?: string; page: number }) {
  const where: (SQL | undefined)[] = [f.state === "all" ? undefined : stateCond(f.state, priceAgreements)];
  if (f.q) where.push(or(ilike(priceAgreements.sku, likeTerm(f.q)), ilike(priceAgreements.agreementRef, likeTerm(f.q)), ilike(priceAgreements.description, likeTerm(f.q)), ilike(suppliers.name, likeTerm(f.q)), ilike(suppliers.code, likeTerm(f.q))));
  if (f.supplierId) where.push(eq(priceAgreements.supplierId, f.supplierId));
  const cond = and(...where);
  const [{ n }] = (await tx.select({ n: count() }).from(priceAgreements).innerJoin(suppliers, eq(suppliers.id, priceAgreements.supplierId)).where(cond)) as [{ n: number }];
  const rows = await tx
    .select({ a: priceAgreements, supplierCode: suppliers.code, supplierName: suppliers.name })
    .from(priceAgreements)
    .innerJoin(suppliers, eq(suppliers.id, priceAgreements.supplierId))
    .where(cond)
    .orderBy(asc(suppliers.code), asc(priceAgreements.sku), desc(priceAgreements.validFrom), desc(priceAgreements.version))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  return { rows, total: n };
}

export async function listCharges(tx: Tx, f: { q?: string; state?: AgreementState | "all"; supplierId?: string; page: number }) {
  const where: (SQL | undefined)[] = [f.state === "all" ? undefined : stateCond(f.state, approvedCharges)];
  if (f.q) where.push(or(ilike(approvedCharges.chargeType, likeTerm(f.q)), ilike(suppliers.name, likeTerm(f.q)), ilike(suppliers.code, likeTerm(f.q))));
  if (f.supplierId) where.push(eq(approvedCharges.supplierId, f.supplierId));
  const cond = and(...where);
  const [{ n }] = (await tx.select({ n: count() }).from(approvedCharges).innerJoin(suppliers, eq(suppliers.id, approvedCharges.supplierId)).where(cond)) as [{ n: number }];
  const rows = await tx
    .select({ c: approvedCharges, supplierCode: suppliers.code, supplierName: suppliers.name })
    .from(approvedCharges)
    .innerJoin(suppliers, eq(suppliers.id, approvedCharges.supplierId))
    .where(cond)
    .orderBy(asc(suppliers.code), asc(approvedCharges.chargeType), desc(approvedCharges.validFrom), desc(approvedCharges.version))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  return { rows, total: n };
}

export async function supplierOptions(tx: Tx) {
  return tx.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.code)).limit(1000);
}

export async function getSupplier(tx: Tx, id: string) {
  const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, id));
  if (!s) return null;
  const [agreements, charges, pos] = await inSequence([
    tx.select().from(priceAgreements).where(eq(priceAgreements.supplierId, id)).orderBy(asc(priceAgreements.sku), desc(priceAgreements.validFrom), desc(priceAgreements.version)).limit(500),
    tx.select().from(approvedCharges).where(eq(approvedCharges.supplierId, id)).orderBy(asc(approvedCharges.chargeType), desc(approvedCharges.validFrom), desc(approvedCharges.version)).limit(500),
    tx.select().from(purchaseOrders).where(eq(purchaseOrders.supplierId, id)).orderBy(desc(purchaseOrders.issuedOn), desc(purchaseOrders.createdAt)).limit(50),
  ]);
  return { supplier: s, agreements, charges, pos };
}

/**
 * Ordered, billed and remaining values per PO line. Billed counts only active
 * ledger rows (those of each invoice's current check run); credit notes are
 * negative rows, so they reduce billed totals. Amounts are NUMERIC throughout.
 */
const lineTotals = sql`
  select l.po_id,
    coalesce(sum(case when not l.cancelled then l.quantity * l.unit_price end), 0) as ordered,
    coalesce(sum(b.amount), 0) as billed,
    count(*) filter (where not l.cancelled)::int as lines
  from po_lines l
  left join (select po_line_id, sum(amount) as amount from po_line_billings where active group by po_line_id) b on b.po_line_id = l.id
  group by l.po_id`;

export async function listPurchaseOrders(tx: Tx, f: { q?: string; status?: "open" | "closed" | "cancelled"; supplierId?: string; page: number }) {
  const where: SQL[] = [];
  if (f.q) where.push(or(ilike(purchaseOrders.poNumber, likeTerm(f.q)), ilike(suppliers.name, likeTerm(f.q)), ilike(suppliers.code, likeTerm(f.q)))!);
  if (f.status) where.push(eq(purchaseOrders.status, f.status));
  if (f.supplierId) where.push(eq(purchaseOrders.supplierId, f.supplierId));
  const cond = where.length ? and(...where) : undefined;
  const [{ n }] = (await tx.select({ n: count() }).from(purchaseOrders).innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId)).where(cond)) as [{ n: number }];
  const rows = await tx
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      status: purchaseOrders.status,
      currency: purchaseOrders.currency,
      issuedOn: purchaseOrders.issuedOn,
      version: purchaseOrders.version,
      supplierId: suppliers.id,
      supplierCode: suppliers.code,
      supplierName: suppliers.name,
      ordered: sql<string>`coalesce(t.ordered, 0)::text`,
      billed: sql<string>`coalesce(t.billed, 0)::text`,
      lines: sql<number>`coalesce(t.lines, 0)`,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .leftJoin(sql`(${lineTotals}) t`, sql`t.po_id = ${purchaseOrders.id}`)
    .where(cond)
    .orderBy(desc(purchaseOrders.issuedOn), desc(purchaseOrders.createdAt))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  return {
    rows: rows.map((r) => ({ ...r, ordered: dec(r.ordered).toFixed(), billed: dec(r.billed).toFixed(), remaining: dec(r.ordered).minus(dec(r.billed)).toFixed() })),
    total: n,
  };
}

export async function getPurchaseOrder(tx: Tx, id: string) {
  const [row] = await tx
    .select({ po: purchaseOrders, supplierCode: suppliers.code, supplierName: suppliers.name })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(eq(purchaseOrders.id, id));
  if (!row) return null;
  const lines = await tx.select().from(poLines).where(eq(poLines.poId, id)).orderBy(asc(poLines.lineNo));
  const lineIds = lines.map((l) => l.id);
  const [billed, recs, revisions] = await inSequence([
    lineIds.length
      ? tx
          .select({
            poLineId: poLineBillings.poLineId,
            qty: sql<string>`coalesce(sum(${poLineBillings.quantity}), 0)::text`,
            amount: sql<string>`coalesce(sum(${poLineBillings.amount}), 0)::text`,
            invoices: sql<number>`count(distinct ${poLineBillings.invoiceId})::int`,
          })
          .from(poLineBillings)
          .where(and(inArray(poLineBillings.poLineId, lineIds), eq(poLineBillings.active, true)))
          .groupBy(poLineBillings.poLineId)
      : Promise.resolve([]),
    lineIds.length ? tx.select().from(receipts).where(inArray(receipts.poLineId, lineIds)).orderBy(asc(receipts.receivedOn)) : Promise.resolve([]),
    tx
      .select({ id: poRevisions.id, version: poRevisions.version, reason: poRevisions.reason, createdAt: poRevisions.createdAt, snapshot: poRevisions.snapshot, by: users.email })
      .from(poRevisions)
      .leftJoin(users, eq(users.id, poRevisions.createdBy))
      .where(eq(poRevisions.poId, id))
      .orderBy(desc(poRevisions.version)),
  ]);
  const billedBy = new Map(billed.map((b) => [b.poLineId, b]));
  const out = lines.map((l) => {
    const b = billedBy.get(l.id);
    const orderedAmount = dec(l.quantity).times(dec(l.unitPrice));
    const billedQty = dec(b?.qty ?? "0");
    const billedAmount = dec(b?.amount ?? "0");
    const received = (recs as (typeof receipts.$inferSelect)[]).filter((r) => r.poLineId === l.id);
    return {
      line: l,
      orderedAmount: orderedAmount.toFixed(),
      billedQty: billedQty.toFixed(),
      billedAmount: billedAmount.toFixed(),
      remainingQty: dec(l.quantity).minus(billedQty).toFixed(),
      remainingAmount: orderedAmount.minus(billedAmount).toFixed(),
      invoices: b?.invoices ?? 0,
      receivedQty: received.reduce((acc, r) => acc.plus(dec(r.quantity)), dec("0")).toFixed(),
      receipts: received,
    };
  });
  const active = out.filter((o) => !o.line.cancelled);
  const sumOf = (k: "orderedAmount" | "billedAmount") => out.filter((o) => k === "billedAmount" || !o.line.cancelled).reduce((acc, o) => acc.plus(dec(o[k])), dec("0"));
  const ordered = sumOf("orderedAmount");
  const billedTotal = sumOf("billedAmount");
  return {
    ...row,
    lines: out,
    activeLineCount: active.length,
    totals: { ordered: ordered.toFixed(), billed: billedTotal.toFixed(), remaining: ordered.minus(billedTotal).toFixed() },
    revisions,
  };
}

export async function listBatches(tx: Tx, f: { kind?: string; status?: string; page: number }) {
  const where: SQL[] = [];
  if (f.kind) where.push(sql`${importBatches.kind} = ${f.kind}`);
  if (f.status) where.push(sql`${importBatches.status} = ${f.status}`);
  const cond = where.length ? and(...where) : undefined;
  const [{ n }] = (await tx.select({ n: count() }).from(importBatches).where(cond)) as [{ n: number }];
  const rows = await tx
    .select({ b: importBatches, by: users.email })
    .from(importBatches)
    .leftJoin(users, eq(users.id, importBatches.createdBy))
    .where(cond)
    .orderBy(desc(importBatches.createdAt))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  return { rows, total: n };
}

export async function getBatchWithRows(tx: Tx, id: string, f: { onlyErrors: boolean; page: number; pageSize?: number }) {
  const [b] = await tx.select({ b: importBatches, by: users.email }).from(importBatches).leftJoin(users, eq(users.id, importBatches.createdBy)).where(eq(importBatches.id, id));
  if (!b) return null;
  const size = f.pageSize ?? 100;
  const cond = and(eq(importRows.batchId, id), f.onlyErrors ? sql`jsonb_array_length(${importRows.errors}) > 0` : undefined);
  const [{ n }] = (await tx.select({ n: count() }).from(importRows).where(cond)) as [{ n: number }];
  const rows = await tx.select().from(importRows).where(cond).orderBy(asc(importRows.rowNumber)).limit(size).offset((f.page - 1) * size);
  return { ...b, rows, total: n, pageSize: size };
}

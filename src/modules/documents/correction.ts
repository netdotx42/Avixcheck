import { and, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { discrepancies, exceptions, invoiceLines, invoices, poLineBillings } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/permissions";
import { enqueue } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES } from "@/lib/jobs/registry";
import { dec, isDecimalString } from "@/lib/money/decimal";
import { DomainError } from "@/lib/orgs";
import { parseCurrency, parseDecimalField, parseIsoDate, cleanText } from "@/modules/extraction/schema";
import { lockInvoice, type Actor } from "./service";

/** Raised when the invoice changed since the editor loaded it. */
export class RevisionConflictError extends DomainError {
  constructor(public readonly currentRevision: number) {
    super("This invoice was changed by someone else or by processing since you opened it. Reload to see the latest values.", "revision_conflict");
  }
}

/** Statuses in which extracted values may be corrected. */
export const CORRECTABLE_STATUSES = ["extraction_review", "matching", "matching_review", "checking", "exceptions_open", "passed", "failed"] as const;

const text = (max: number) => z.string().max(max * 4).nullable().optional().transform((v) => cleanText(v ?? null, max));
const decimalField = (name: string, scale: number) =>
  z.string().max(64).nullable().optional().transform((v, ctx) => {
    const r = parseDecimalField(v ?? null, scale);
    if (r.issue) ctx.addIssue({ code: "custom", message: `${name}: ${r.issue}` });
    return r.value;
  });
const dateField = (name: string) =>
  z.string().max(32).nullable().optional().transform((v, ctx) => {
    const r = parseIsoDate(v ?? null);
    if (r.issue) ctx.addIssue({ code: "custom", message: `${name}: ${r.issue}` });
    return r.value;
  });

export const correctionSchema = z.object({
  header: z.object({
    kind: z.enum(["invoice", "credit_note"]),
    supplierNameRaw: text(500),
    supplierTaxIdRaw: text(64),
    invoiceNumber: text(100),
    invoiceDate: dateField("Invoice date"),
    dueDate: dateField("Due date"),
    currency: z.string().max(16).nullable().optional().transform((v, ctx) => {
      const r = parseCurrency(v ?? null);
      if (r.issue) ctx.addIssue({ code: "custom", message: `Currency: ${r.issue}` });
      return r.value;
    }),
    poNumberRaw: text(100),
    creditsInvoiceNumberRaw: text(100),
    subtotal: decimalField("Subtotal", 4),
    taxTotal: decimalField("Tax", 4),
    total: decimalField("Total", 4),
  }),
  lines: z
    .array(
      z.object({
        id: z.string().uuid().nullable().optional(),
        lineType: z.enum(["goods", "charge", "discount"]),
        chargeType: text(100),
        sku: text(100),
        description: text(500),
        quantity: decimalField("Quantity", 4),
        unit: text(32),
        unitPrice: decimalField("Unit price", 6),
        amount: decimalField("Amount", 4),
        taxRate: decimalField("Tax rate", 4),
        poLineRef: text(100),
      }),
    )
    .max(500),
});
export type CorrectionInput = z.input<typeof correctionSchema>;

const HEADER_FIELDS = ["kind", "supplierNameRaw", "supplierTaxIdRaw", "invoiceNumber", "invoiceDate", "dueDate", "currency", "poNumberRaw", "creditsInvoiceNumberRaw", "subtotal", "taxTotal", "total"] as const;
const LINE_FIELDS = ["lineType", "chargeType", "sku", "description", "quantity", "unit", "unitPrice", "amount", "taxRate", "poLineRef"] as const;

/** Compare field values; NUMERIC strings compare by value so "10" equals "10.0000". */
function same(a: unknown, b: unknown) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (typeof x === "string" && typeof y === "string" && isDecimalString(x) && isDecimalString(y)) return dec(x).equals(dec(y));
  return String(x) === String(y);
}

/** Fields an invoice must have before it can be matched and checked. */
export function missingRequired(
  h: { supplierNameRaw: string | null; invoiceNumber: string | null; invoiceDate: string | null; currency: string | null; total: string | null },
  lines: { amount: string | null }[],
): string[] {
  const missing: string[] = [];
  if (!h.supplierNameRaw) missing.push("supplier name");
  if (!h.invoiceNumber) missing.push("invoice number");
  if (!h.invoiceDate) missing.push("invoice date");
  if (!h.currency) missing.push("currency");
  if (!h.total) missing.push("total");
  if (lines.length === 0) missing.push("at least one line item");
  else if (lines.some((l) => l.amount === null)) missing.push("line amounts");
  return missing;
}

/**
 * Apply a reviewer's corrections to an invoice's header and lines.
 * - Optimistic concurrency via `expectedRevision`; the invoice row is locked.
 * - Each changed line is flagged `manually_corrected` and audited with before/after.
 * - Lines referenced by earlier check runs cannot be deleted (history is kept).
 * - The revision is bumped and matching is re-queued with a revision-scoped key,
 *   so the engine re-runs against the corrected values.
 */
export async function correctInvoice(actor: Actor, invoiceId: string, expectedRevision: number, input: CorrectionInput) {
  assertCan(actor.role, "invoice.edit");
  const parsed = correctionSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => i.message).slice(0, 5).join("; "), "invalid_correction");
  const data = parsed.data;

  return withTenant(actor.orgId, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    if (!inv) throw new DomainError("Invoice not found", "not_found");
    if (inv.revision !== expectedRevision) throw new RevisionConflictError(inv.revision);
    if (!(CORRECTABLE_STATUSES as readonly string[]).includes(inv.status)) {
      throw new DomainError(`An invoice in status "${inv.status}" cannot be corrected.`, "not_correctable");
    }

    const existing = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    const byId = new Map(existing.map((l) => [l.id, l]));
    for (const l of data.lines) if (l.id && !byId.has(l.id)) throw new DomainError("A line being edited no longer exists. Reload and try again.", "unknown_line");

    const changedHeader: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of HEADER_FIELDS) {
      const before = inv[f];
      const after = data.header[f];
      if (!same(before, after)) changedHeader[f] = { from: before ?? null, to: after ?? null };
    }

    const keptIds = new Set(data.lines.flatMap((l) => (l.id ? [l.id] : [])));
    const removed = existing.filter((l) => !keptIds.has(l.id));
    if (removed.length) {
      const ids = removed.map((l) => l.id);
      const refs = await tx.execute(sql`
        select 1 from ${poLineBillings} where ${poLineBillings.invoiceLineId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        union all
        select 1 from ${discrepancies} where ${discrepancies.invoiceLineId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        limit 1`);
      if (refs.rows.length) throw new DomainError("A removed line is referenced by an earlier check. Set its amount to 0 instead of deleting it, so the history stays intact.", "line_referenced");
      await tx.delete(invoiceLines).where(and(eq(invoiceLines.invoiceId, invoiceId), inArray(invoiceLines.id, ids)));
    }

    const [{ maxNo }] = (await tx.select({ maxNo: max(invoiceLines.lineNo) }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))) as [{ maxNo: number | null }];
    let nextNo = (maxNo ?? 0) + 1;
    const lineChanges: { lineId: string; lineNo: number; change: "updated" | "added"; fields: Record<string, { from: unknown; to: unknown }> }[] = [];

    for (const l of data.lines) {
      const values = Object.fromEntries(LINE_FIELDS.map((f) => [f, l[f] ?? null])) as Record<(typeof LINE_FIELDS)[number], string | null>;
      if (l.id) {
        const before = byId.get(l.id)!;
        const fields: Record<string, { from: unknown; to: unknown }> = {};
        for (const f of LINE_FIELDS) if (!same(before[f], values[f])) fields[f] = { from: before[f] ?? null, to: values[f] };
        if (Object.keys(fields).length === 0) continue;
        await tx
          .update(invoiceLines)
          .set({ ...values, lineType: l.lineType, manuallyCorrected: true, matchedPoLineId: null, matchedAgreementId: null, matchConfidence: null, updatedAt: new Date() })
          .where(eq(invoiceLines.id, l.id));
        lineChanges.push({ lineId: l.id, lineNo: before.lineNo, change: "updated", fields });
      } else {
        const [row] = await tx
          .insert(invoiceLines)
          .values({ ...values, lineType: l.lineType, orgId: actor.orgId, invoiceId, lineNo: nextNo++, manuallyCorrected: true })
          .returning({ id: invoiceLines.id, lineNo: invoiceLines.lineNo });
        lineChanges.push({ lineId: row!.id, lineNo: row!.lineNo, change: "added", fields: Object.fromEntries(LINE_FIELDS.map((f) => [f, { from: null, to: values[f] }])) });
      }
    }

    const changed = Object.keys(changedHeader).length > 0 || lineChanges.length > 0 || removed.length > 0;
    const missing = missingRequired(data.header, data.lines);
    // Saving unchanged values on an invoice under extraction review confirms them as correct.
    const confirming = !changed && inv.status === "extraction_review";
    if (!changed && !confirming) return { revision: inv.revision, changed: false, confirmed: false, missing };
    if (confirming && missing.length) {
      throw new DomainError(`These values are still missing: ${missing.join(", ")}. Fill them in from the document before confirming.`, "missing_required");
    }

    const revision = inv.revision + 1;
    // Incomplete invoices stay in review; they never reach matching or checks with missing data.
    const status = missing.length ? "extraction_review" : "matching";
    await tx
      .update(invoices)
      .set({ ...data.header, revision, status, failureReason: null, supplierId: null, purchaseOrderId: null, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));

    if (Object.keys(changedHeader).length) {
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "invoice.header_corrected", entityType: "invoice", entityId: invoiceId, data: { revision, fields: changedHeader }, requestId: actor.requestId });
    }
    for (const c of lineChanges) {
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "invoice.line_corrected", entityType: "invoice_line", entityId: c.lineId, data: { invoiceId, revision, lineNo: c.lineNo, change: c.change, fields: c.fields }, requestId: actor.requestId });
    }
    for (const r of removed) {
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "invoice.line_corrected", entityType: "invoice_line", entityId: r.id, data: { invoiceId, revision, lineNo: r.lineNo, change: "removed" }, requestId: actor.requestId });
    }
    if (confirming) {
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "invoice.extraction_confirmed", entityType: "invoice", entityId: invoiceId, data: { revision }, requestId: actor.requestId });
    }
    if (missing.length) return { revision, changed, confirmed: false, missing };

    // The correction (or confirmation) resolves any open extraction review for this invoice.
    const reason = confirming ? `Extracted values confirmed by reviewer (revision ${revision})` : `Resolved by manual correction (revision ${revision})`;
    const resolved = await tx
      .update(exceptions)
      .set({ status: "dismissed", decisionReason: reason, decidedBy: actor.userId, decidedAt: new Date(), revision: sql`${exceptions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(exceptions.invoiceId, invoiceId), eq(exceptions.kind, "extraction_review"), inArray(exceptions.status, ["open", "in_review"])))
      .returning({ id: exceptions.id });
    for (const e of resolved) {
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "exception.decided", entityType: "exception", entityId: e.id, data: { invoiceId, status: "dismissed", reason: confirming ? "extraction_confirmed" : "manual_correction", revision }, requestId: actor.requestId });
    }

    await enqueue(tx, {
      orgId: actor.orgId,
      type: JOB_TYPES.matchInvoice,
      payload: { invoiceId, revision },
      idempotencyKey: idempotencyKey(actor.orgId, JOB_TYPES.matchInvoice, invoiceId, revision),
      createdBy: actor.userId,
    });
    return { revision, changed, confirmed: confirming, missing };
  });
}

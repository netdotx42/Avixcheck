import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import { exceptions, invoiceLines, invoices, organizations, poLines, priceAgreements, purchaseOrders, suppliers } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { assertCan, type Role } from "@/lib/auth/permissions";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES } from "@/lib/jobs/registry";
import { parseOrgSettings } from "@/lib/org-settings";
import { DomainError } from "@/lib/orgs";
import { RULE_SET_VERSION } from "../checks/version";
import { matchInvoice, resolveSupplier } from "./match";
import { normId } from "./normalize";
import type { AgreementRef, LineMatch, MatchResult, PoLineRef, PoRef, RefMatch, SupplierRef } from "./types";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

/** Invoice states from which matching must not start (document not ready, or out of the pipeline). */
const NOT_MATCHABLE = new Set(["uploaded", "scanning", "quarantined", "extracting", "extraction_review", "rejected"]);

const SUPPLIER_COLS = {
  id: suppliers.id,
  code: suppliers.code,
  name: suppliers.name,
  taxId: suppliers.taxId,
  aliases: suppliers.aliases,
  currency: suppliers.currency,
  active: suppliers.active,
  version: suppliers.version,
};

/**
 * Hand an invoice to the matcher. Call inside the tenant transaction that made
 * the invoice ready (extraction finished, manual correction saved). Moves the
 * invoice to `matching` and enqueues `invoice.match` keyed by revision, so a
 * retry or double submit never matches the same revision twice.
 */
export async function enqueueMatch(tx: Tx, input: { orgId: string; invoiceId: string; revision: number; createdBy?: string | null }) {
  await tx.update(invoices).set({ status: "matching", updatedAt: new Date() }).where(and(eq(invoices.id, input.invoiceId), eq(invoices.revision, input.revision)));
  return enqueue(tx, {
    orgId: input.orgId,
    type: JOB_TYPES.matchInvoice,
    payload: { invoiceId: input.invoiceId, revision: input.revision },
    idempotencyKey: idempotencyKey(input.orgId, JOB_TYPES.matchInvoice, input.invoiceId, input.revision),
    createdBy: input.createdBy ?? null,
  });
}

export async function enqueueCheck(tx: Tx, input: { orgId: string; invoiceId: string; revision: number; createdBy?: string | null }) {
  return enqueue(tx, {
    orgId: input.orgId,
    type: JOB_TYPES.checkInvoice,
    payload: { invoiceId: input.invoiceId, revision: input.revision },
    idempotencyKey: idempotencyKey(input.orgId, JOB_TYPES.checkInvoice, input.invoiceId, input.revision),
    createdBy: input.createdBy ?? null,
  });
}

export type MatchOutcome =
  | { status: "skipped"; reason: string }
  | { status: "review"; exceptionId: string | null }
  | { status: "checking" };

/** `invoice.match` job body. Idempotent per (invoice, revision). */
export async function runMatching(orgId: string, invoiceId: string, revision: number): Promise<MatchOutcome> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!inv) throw new PermanentJobError("Invoice not found");
    if (inv.revision !== revision) return { status: "skipped", reason: `stale revision ${revision} (current ${inv.revision})` };
    if (NOT_MATCHABLE.has(inv.status)) return { status: "skipped", reason: `invoice is ${inv.status}` };
    const prior = inv.matchResult as MatchResult | null;
    if (prior && prior.revision === revision && inv.status !== "matching" && inv.status !== "failed") return { status: "skipped", reason: "already matched" };

    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    const settings = parseOrgSettings(org?.settings);
    const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.lineNo);
    const supplierRows: SupplierRef[] = await tx.select(SUPPLIER_COLS).from(suppliers);

    // Candidate POs: by normalised number, plus open POs of likely suppliers (for invoices without a PO number).
    const header = {
      supplierId: inv.supplierId,
      supplierNameRaw: inv.supplierNameRaw,
      supplierTaxIdRaw: inv.supplierTaxIdRaw,
      poNumberRaw: inv.poNumberRaw,
      invoiceDate: inv.invoiceDate,
      currency: inv.currency,
    };
    const pre = resolveSupplier(header, supplierRows);
    const likelySuppliers = [pre.id, ...pre.candidates.map((c) => c.id)].filter((x): x is string => Boolean(x));
    const poNorm = normId(inv.poNumberRaw);
    const poConds = [];
    if (poNorm) poConds.push(sql`regexp_replace(upper(${purchaseOrders.poNumber}), '[^A-Z0-9]', '', 'g') = ${poNorm}`);
    // Credit notes may omit the PO but reference the credited invoice.
    if (inv.creditsInvoiceId) {
      const [credited] = await tx.select({ poId: invoices.purchaseOrderId }).from(invoices).where(eq(invoices.id, inv.creditsInvoiceId));
      if (credited?.poId && !poNorm) {
        const [p] = await tx.select({ poNumber: purchaseOrders.poNumber }).from(purchaseOrders).where(eq(purchaseOrders.id, credited.poId));
        if (p) header.poNumberRaw = p.poNumber;
        poConds.push(eq(purchaseOrders.id, credited.poId));
      }
    }
    if (likelySuppliers.length) poConds.push(and(inArray(purchaseOrders.supplierId, likelySuppliers), eq(purchaseOrders.status, "open"))!);
    const poRows: PoRef[] = poConds.length
      ? await tx
          .select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId, poNumber: purchaseOrders.poNumber, currency: purchaseOrders.currency, status: purchaseOrders.status, version: purchaseOrders.version })
          .from(purchaseOrders)
          .where(or(...poConds))
      : [];
    const poLineRows: PoLineRef[] = poRows.length
      ? await tx
          .select({ id: poLines.id, poId: poLines.poId, lineNo: poLines.lineNo, sku: poLines.sku, description: poLines.description, quantity: poLines.quantity, unit: poLines.unit, unitPrice: poLines.unitPrice, cancelled: poLines.cancelled })
          .from(poLines)
          .where(inArray(poLines.poId, poRows.map((p) => p.id)))
      : [];
    const agreementSuppliers = [...new Set([...likelySuppliers, ...poRows.map((p) => p.supplierId)])];
    const agreements = agreementSuppliers.length ? await loadAgreements(tx, agreementSuppliers) : [];

    const result = matchInvoice({
      revision,
      header,
      lines: lines.map((l) => ({ id: l.id, lineNo: l.lineNo, lineType: l.lineType, sku: l.sku, description: l.description, unit: l.unit, unitPrice: l.unitPrice, poLineRef: l.poLineRef })),
      suppliers: supplierRows,
      purchaseOrders: poRows,
      poLines: poLineRows,
      agreements,
      minConfidence: settings.review.minMatchConfidence,
    });

    await persistMatch(tx, invoiceId, result);
    const summary = summarise(result);
    await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "invoice.matched", entityType: "invoice", entityId: invoiceId, data: { revision, ruleSetVersion: RULE_SET_VERSION, ...summary } });

    if (inv.status === "failed") await closeOpenExceptions(tx, { orgId, invoiceId, kinds: ["processing_failure"], reason: "Matching succeeded on retry", actorUserId: null });
    if (result.needsReview) {
      await tx.update(invoices).set({ status: "matching_review", updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
      const [open] = await tx
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(and(eq(exceptions.invoiceId, invoiceId), eq(exceptions.kind, "matching_review"), inArray(exceptions.status, ["open", "in_review"])));
      let exceptionId = open?.id ?? null;
      if (!open) {
        const [ex] = await tx
          .insert(exceptions)
          .values({ orgId, invoiceId, kind: "matching_review", title: `Confirm match: ${summary.lowConfidence.join("; ")}`.slice(0, 300) })
          .returning({ id: exceptions.id });
        exceptionId = ex!.id;
        await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "exception.created", entityType: "exception", entityId: exceptionId, data: { kind: "matching_review", invoiceId, revision } });
      }
      return { status: "review", exceptionId };
    }

    await tx.update(invoices).set({ status: "checking", updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    await enqueueCheck(tx, { orgId, invoiceId, revision });
    return { status: "checking" };
  });
}

export async function loadAgreements(tx: Tx, supplierIds: string[]): Promise<AgreementRef[]> {
  const rows = await tx
    .select()
    .from(priceAgreements)
    .where(and(inArray(priceAgreements.supplierId, supplierIds), isNull(priceAgreements.supersededAt)));
  return rows.map(toAgreementRef);
}

export function toAgreementRef(a: typeof priceAgreements.$inferSelect): AgreementRef {
  return {
    id: a.id,
    supplierId: a.supplierId,
    agreementRef: a.agreementRef,
    sku: a.sku,
    unitPrice: a.unitPrice,
    currency: a.currency,
    unit: a.unit,
    discountPct: a.discountPct,
    minQuantity: a.minQuantity,
    validFrom: a.validFrom,
    validTo: a.validTo,
    version: a.version,
    supersededAt: a.supersededAt ? a.supersededAt.toISOString() : null,
  };
}

const usable = (m: RefMatch) => (m.status === "matched" || m.status === "low_confidence" || m.status === "manual" ? m.id : null);

async function persistMatch(tx: Tx, invoiceId: string, result: MatchResult) {
  await tx
    .update(invoices)
    .set({ supplierId: usable(result.supplier), purchaseOrderId: usable(result.purchaseOrder), matchResult: result, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));
  for (const l of result.lines) {
    await tx
      .update(invoiceLines)
      .set({ matchedPoLineId: usable(l.poLine), matchedAgreementId: usable(l.agreement), matchConfidence: l.poLine.confidence, updatedAt: new Date() })
      .where(eq(invoiceLines.id, l.invoiceLineId));
  }
}

function summarise(r: MatchResult) {
  const lowConfidence: string[] = [];
  const issues: string[] = [];
  const note = (label: string, m: RefMatch) => {
    if (m.status === "low_confidence") lowConfidence.push(`${label}: ${m.reason}`);
    if (m.status === "missing" || m.status === "conflicting") issues.push(`${label}: ${m.status}`);
  };
  note("supplier", r.supplier);
  note("PO", r.purchaseOrder);
  for (const l of r.lines) {
    note(`line ${l.lineNo}`, l.poLine);
    if (l.agreement.status === "conflicting") note(`line ${l.lineNo} agreement`, l.agreement);
  }
  return { supplier: r.supplier.status, purchaseOrder: r.purchaseOrder.status, needsReview: r.needsReview, lowConfidence, issues };
}

/** Dismiss open review exceptions of a kind once a person or a later run has dealt with them. */
export async function closeOpenExceptions(tx: Tx, a: { orgId: string; invoiceId: string; kinds: ("matching_review" | "processing_failure" | "discrepancy")[]; reason: string; actorUserId: string | null }) {
  const closed = await tx
    .update(exceptions)
    .set({ status: "dismissed", decisionReason: a.reason, decidedBy: a.actorUserId, decidedAt: new Date(), revision: sql`${exceptions.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(exceptions.invoiceId, a.invoiceId), inArray(exceptions.kind, a.kinds), inArray(exceptions.status, ["open", "in_review"])))
    .returning({ id: exceptions.id, kind: exceptions.kind, assigneeUserId: exceptions.assigneeUserId, discrepancyId: exceptions.discrepancyId });
  if (closed.length) {
    await audit(tx, {
      orgId: a.orgId,
      actorUserId: a.actorUserId,
      actorType: a.actorUserId ? "user" : "system",
      action: "exception.superseded",
      entityType: "invoice",
      entityId: a.invoiceId,
      data: { exceptionIds: closed.map((c) => c.id), reason: a.reason },
    });
  }
  return closed;
}

/** Ask for a fresh match + check (e.g. after reference data changed). Bumps the invoice revision. */
export async function requestRecheck(actor: Actor, invoiceId: string, expectedRevision: number) {
  assertCan(actor.role, "invoice.recheck");
  return withTenant(actor.orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!inv) throw new DomainError("Invoice not found", "not_found");
    if (inv.revision !== expectedRevision) throw new DomainError("The invoice changed since you loaded it. Reload and try again.", "conflict");
    if (NOT_MATCHABLE.has(inv.status)) throw new DomainError(`An invoice that is ${inv.status.replace("_", " ")} cannot be rechecked`, "invalid_state");
    const revision = inv.revision + 1;
    await tx.update(invoices).set({ revision, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "invoice.recheck_requested", entityType: "invoice", entityId: invoiceId, data: { revision } });
    await enqueueMatch(tx, { orgId: actor.orgId, invoiceId, revision, createdBy: actor.userId });
    return { revision };
  });
}

export const confirmMatchSchema = z.object({
  invoiceId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  supplierId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().nullable(),
  lines: z
    .array(z.object({ invoiceLineId: z.string().uuid(), poLineId: z.string().uuid().nullable(), agreementId: z.string().uuid().nullable() }))
    .max(1000),
  note: z.string().trim().max(1000).optional(),
});
export type ConfirmMatchInput = z.infer<typeof confirmMatchSchema>;

const manual = (id: string | null, reason: string, fallback?: RefMatch): RefMatch =>
  id
    ? { status: "manual", id, confidence: "1.0000", method: "manual", reason, candidates: [] }
    : fallback ?? { status: "missing", id: null, confidence: null, method: null, reason: "Left unmatched by reviewer", candidates: [] };

/**
 * A reviewer confirms or corrects the supplier / PO / line matches. Every id is
 * re-validated server-side against this tenant and against each other, then the
 * invoice moves to checking with a new revision.
 */
export async function confirmMatch(actor: Actor, raw: ConfirmMatchInput) {
  assertCan(actor.role, "invoice.edit");
  const input = confirmMatchSchema.parse(raw);
  return withTenant(actor.orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update");
    if (!inv) throw new DomainError("Invoice not found", "not_found");
    if (inv.revision !== input.expectedRevision) throw new DomainError("The invoice changed since you loaded it. Reload and try again.", "conflict");
    if (NOT_MATCHABLE.has(inv.status)) throw new DomainError(`An invoice that is ${inv.status.replace("_", " ")} cannot be matched`, "invalid_state");

    const [sup] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId));
    if (!sup) throw new DomainError("Supplier not found", "invalid_reference");
    let po: { id: string; supplierId: string } | undefined;
    if (input.purchaseOrderId) {
      [po] = await tx.select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId }).from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId));
      if (!po) throw new DomainError("Purchase order not found", "invalid_reference");
      if (po.supplierId !== sup.id) throw new DomainError("The purchase order belongs to a different supplier", "invalid_reference");
    }
    const lines = await tx.select({ id: invoiceLines.id, lineNo: invoiceLines.lineNo }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const lineIds = new Set(lines.map((l) => l.id));
    const poLineIds = input.lines.map((l) => l.poLineId).filter((x): x is string => Boolean(x));
    const agreementIds = input.lines.map((l) => l.agreementId).filter((x): x is string => Boolean(x));
    if (poLineIds.length) {
      if (!po) throw new DomainError("Select a purchase order before matching PO lines", "invalid_reference");
      const found = await tx.select({ id: poLines.id }).from(poLines).where(and(inArray(poLines.id, poLineIds), eq(poLines.poId, po.id)));
      if (found.length !== new Set(poLineIds).size) throw new DomainError("A PO line does not belong to the selected purchase order", "invalid_reference");
    }
    if (agreementIds.length) {
      const found = await tx.select({ id: priceAgreements.id }).from(priceAgreements).where(and(inArray(priceAgreements.id, agreementIds), eq(priceAgreements.supplierId, sup.id)));
      if (found.length !== new Set(agreementIds).size) throw new DomainError("An agreement does not belong to the selected supplier", "invalid_reference");
    }
    for (const l of input.lines) if (!lineIds.has(l.invoiceLineId)) throw new DomainError("Unknown invoice line", "invalid_reference");

    const prior = inv.matchResult as MatchResult | null;
    const revision = inv.revision + 1;
    const reason = `Confirmed by reviewer${input.note ? `: ${input.note}` : ""}`;
    const resultLines: LineMatch[] = lines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => {
        const given = input.lines.find((x) => x.invoiceLineId === l.id);
        const before = prior?.lines.find((x) => x.invoiceLineId === l.id);
        // Lines the reviewer did not touch keep a trusted automatic match; anything else stays unmatched and is flagged.
        const keep = (m: RefMatch | undefined) => (m && (m.status === "matched" || m.status === "not_applicable") ? m : undefined);
        return {
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          poLine: given ? manual(given.poLineId, reason) : manual(null, reason, keep(before?.poLine)),
          agreement: given ? (given.agreementId ? manual(given.agreementId, reason) : { status: "not_applicable", id: null, confidence: null, method: "manual", reason: "No agreement selected by reviewer", candidates: [] }) : manual(null, reason, keep(before?.agreement) ?? { status: "not_applicable", id: null, confidence: null, method: null, reason: "Not reviewed", candidates: [] }),
        };
      });
    const result: MatchResult = {
      ruleSetVersion: RULE_SET_VERSION,
      revision,
      supplier: manual(sup.id, reason),
      purchaseOrder: manual(po?.id ?? null, reason, { status: "missing", id: null, confidence: null, method: "manual", reason: "No purchase order selected by reviewer", candidates: [] }),
      lines: resultLines,
      needsReview: false,
      matchedAt: new Date().toISOString(),
    };
    await tx.update(invoices).set({ revision, status: "checking", updatedAt: new Date() }).where(eq(invoices.id, inv.id));
    await persistMatch(tx, inv.id, result);
    await closeOpenExceptions(tx, { orgId: actor.orgId, invoiceId: inv.id, kinds: ["matching_review"], reason: "Match confirmed by reviewer", actorUserId: actor.userId });
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "invoice.match_confirmed",
      entityType: "invoice",
      entityId: inv.id,
      data: { revision, supplierId: sup.id, purchaseOrderId: po?.id ?? null, lines: input.lines, note: input.note ?? null },
    });
    await enqueueCheck(tx, { orgId: actor.orgId, invoiceId: inv.id, revision, createdBy: actor.userId });
    return { revision };
  });
}

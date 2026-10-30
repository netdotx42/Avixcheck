import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  approvedCharges,
  checkRuns,
  discrepancies,
  documents,
  exceptions,
  invoiceLines,
  invoices,
  organizations,
  poLineBillings,
  poLines,
  priceAgreements,
  purchaseOrders,
  receipts,
  suppliers,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { PermanentJobError } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES } from "@/lib/jobs/registry";
import { dec, sum } from "@/lib/money/decimal";
import { parseOrgSettings } from "@/lib/org-settings";
import { isTrusted } from "../matching/match";
import { normId } from "../matching/normalize";
import { closeOpenExceptions, toAgreementRef } from "../matching/service";
import type { MatchResult } from "../matching/types";
import { activeBilledByPoLine } from "./balances";
import { evaluateInvoice } from "./rules";
import type { CheckInput, DuplicateCandidate, Finding, PoLineState } from "./types";
import { RULE_SET_VERSION } from "./version";

export type CheckOutcomeSummary =
  | { status: "skipped"; reason: string }
  | { status: "completed"; checkRunId: string; reused: boolean; discrepancies: number; invoiceStatus: "passed" | "exceptions_open" };

/** Invoice states in which a check run may start. `failed` allows manual recovery by retrying the job. */
const CHECKABLE = new Set(["checking", "failed"]);

const fingerprint = (f: { type: string; lineNo: number | null }) => `${f.type}:${f.lineNo ?? "-"}`;

/**
 * `invoice.check` job body. One transaction:
 *   lock invoice → (idempotency check) → lock PO and PO lines → load reference
 *   data and other invoices' active billings → evaluate rules → supersede prior
 *   runs and deactivate their billings → write run, discrepancies, exceptions,
 *   billings → set invoice status.
 *
 * Idempotency key org:invoice.check:invoice:revision is unique on check_runs, so a
 * retried job returns the committed run instead of creating duplicates. Locking
 * the PO row serialises concurrent checks of invoices billing the same PO, so a
 * balance is never consumed twice.
 */
export async function runCheck(orgId: string, invoiceId: string, revision: number): Promise<CheckOutcomeSummary> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!inv) throw new PermanentJobError("Invoice not found");
    const key = idempotencyKey(orgId, JOB_TYPES.checkInvoice, invoiceId, revision);
    const [existing] = await tx.select().from(checkRuns).where(eq(checkRuns.idempotencyKey, key));
    if (existing) {
      const n = await tx.select({ id: discrepancies.id }).from(discrepancies).where(eq(discrepancies.checkRunId, existing.id));
      return { status: "completed", checkRunId: existing.id, reused: true, discrepancies: n.length, invoiceStatus: inv.status === "passed" ? "passed" : "exceptions_open" };
    }
    if (inv.revision !== revision) return { status: "skipped", reason: `stale revision ${revision} (current ${inv.revision})` };
    if (!CHECKABLE.has(inv.status)) return { status: "skipped", reason: `invoice is ${inv.status}` };
    const match = inv.matchResult as MatchResult | null;
    if (!match || match.revision !== revision) throw new PermanentJobError("No match result for this invoice revision; run matching first");
    if (match.needsReview) return { status: "skipped", reason: "matching needs review" };

    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    const settings = parseOrgSettings(org?.settings);
    const [doc] = await tx.select({ sha256: documents.sha256 }).from(documents).where(eq(documents.id, inv.documentId));
    const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo));

    const supplierId = isTrusted(match.supplier) ? match.supplier.id : null;
    const poId = isTrusted(match.purchaseOrder) ? match.purchaseOrder.id : null;
    const [supplier] = supplierId ? await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)) : [];
    // Lock order: invoice → purchase order → PO lines (by id). Every check follows it, so no deadlocks.
    const [po] = poId ? await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for("update") : [];
    const poLineRows = po ? await tx.select().from(poLines).where(eq(poLines.poId, po.id)).orderBy(asc(poLines.id)).for("update") : [];
    const lineIds = poLineRows.map((l) => l.id);
    const billed = await activeBilledByPoLine(tx, lineIds, invoiceId);
    const receiptRows = lineIds.length ? await tx.select().from(receipts).where(inArray(receipts.poLineId, lineIds)) : [];
    const poLineStates: PoLineState[] = poLineRows.map((l) => {
      const rs = receiptRows.filter((r) => r.poLineId === l.id);
      return {
        id: l.id,
        poId: l.poId,
        lineNo: l.lineNo,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        cancelled: l.cancelled,
        billedQuantityOther: billed.get(l.id)?.quantity ?? "0",
        receivedQuantity: rs.length ? sum(rs.map((r) => dec(r.quantity))).toString() : null,
        receiptIds: rs.map((r) => r.id),
      };
    });
    const poBilledAmountOther = sum([...billed.values()].map((b) => dec(b.amount))).toString();

    const agreementIds = match.lines.map((l) => (isTrusted(l.agreement) ? l.agreement.id : null)).filter((x): x is string => Boolean(x));
    const agreementRows = agreementIds.length ? await tx.select().from(priceAgreements).where(inArray(priceAgreements.id, agreementIds)) : [];
    const chargeRows = supplierId ? await tx.select().from(approvedCharges).where(eq(approvedCharges.supplierId, supplierId)) : [];
    const duplicateCandidates = await loadDuplicateCandidates(tx, inv, supplierId, doc?.sha256 ?? null);

    const input: CheckInput = {
      settings,
      invoice: {
        id: inv.id,
        kind: inv.kind,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        currency: inv.currency,
        subtotal: inv.subtotal,
        taxTotal: inv.taxTotal,
        total: inv.total,
        documentId: inv.documentId,
        documentSha256: doc?.sha256 ?? null,
      },
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        lineType: l.lineType,
        chargeType: l.chargeType,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        amount: l.amount,
      })),
      match,
      supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.name, taxId: supplier.taxId, aliases: supplier.aliases, currency: supplier.currency, active: supplier.active, version: supplier.version } : null,
      purchaseOrder: po ? { id: po.id, supplierId: po.supplierId, poNumber: po.poNumber, currency: po.currency, status: po.status, version: po.version } : null,
      poLines: poLineStates,
      poBilledAmountOther,
      agreements: agreementRows.map(toAgreementRef),
      approvedCharges: chargeRows.map((c) => ({ id: c.id, supplierId: c.supplierId, chargeType: c.chargeType, maxAmount: c.maxAmount, currency: c.currency, validFrom: c.validFrom, validTo: c.validTo })),
      duplicateCandidates,
    };
    const outcome = evaluateInvoice(input);

    // Supersede earlier runs: their billings stop counting in the same transaction.
    const superseded = await tx
      .update(checkRuns)
      .set({ status: "superseded" })
      .where(and(eq(checkRuns.invoiceId, invoiceId), eq(checkRuns.status, "completed")))
      .returning({ id: checkRuns.id });
    await tx.update(poLineBillings).set({ active: false }).where(and(eq(poLineBillings.invoiceId, invoiceId), eq(poLineBillings.active, true)));

    const [run] = await tx
      .insert(checkRuns)
      .values({
        orgId,
        invoiceId,
        status: "completed",
        ruleSetVersion: RULE_SET_VERSION,
        settingsSnapshot: settings,
        referenceSnapshot: {
          match,
          supplier: supplier ? { id: supplier.id, code: supplier.code, version: supplier.version } : null,
          purchaseOrder: po ? { id: po.id, poNumber: po.poNumber, version: po.version, status: po.status, currency: po.currency } : null,
          poLines: poLineStates.map((l) => ({ id: l.id, lineNo: l.lineNo, quantity: l.quantity, unitPrice: l.unitPrice, unit: l.unit, cancelled: l.cancelled, billedQuantityOther: l.billedQuantityOther, receivedQuantity: l.receivedQuantity, receiptIds: l.receiptIds })),
          poBilledAmountOther,
          agreements: agreementRows.map((a) => ({ id: a.id, ref: a.agreementRef, version: a.version, unitPrice: a.unitPrice, currency: a.currency, unit: a.unit, discountPct: a.discountPct, minQuantity: a.minQuantity, validFrom: a.validFrom, validTo: a.validTo })),
          approvedCharges: chargeRows.map((c) => ({ id: c.id, chargeType: c.chargeType, maxAmount: c.maxAmount, currency: c.currency, validFrom: c.validFrom, validTo: c.validTo })),
          duplicateCandidateIds: duplicateCandidates.map((d) => d.id),
          supersededRunIds: superseded.map((s) => s.id),
        },
        invoiceRevision: revision,
        idempotencyKey: key,
        completedAt: new Date(),
      })
      .returning({ id: checkRuns.id });
    const checkRunId = run!.id;

    // Open exceptions of the earlier run are superseded; their assignee carries over to the same finding.
    const previous = await closeOpenExceptions(tx, { orgId, invoiceId, kinds: ["discrepancy", "processing_failure"], reason: `Superseded by check run ${checkRunId}`, actorUserId: null });
    const prevDiscrepancyIds = previous.map((p) => p.discrepancyId).filter((x): x is string => Boolean(x));
    const prevDiscrepancies = prevDiscrepancyIds.length
      ? await tx.select({ id: discrepancies.id, type: discrepancies.type, invoiceLineId: discrepancies.invoiceLineId }).from(discrepancies).where(inArray(discrepancies.id, prevDiscrepancyIds))
      : [];
    const lineNoById = new Map(lines.map((l) => [l.id, l.lineNo]));
    const assignees = new Map<string, string>();
    for (const p of previous) {
      const d = prevDiscrepancies.find((x) => x.id === p.discrepancyId);
      if (d && p.assigneeUserId) assignees.set(fingerprint({ type: d.type, lineNo: d.invoiceLineId ? lineNoById.get(d.invoiceLineId) ?? null : null }), p.assigneeUserId);
    }

    for (const f of outcome.findings) await insertFinding(tx, orgId, invoiceId, checkRunId, f, assignees.get(fingerprint(f)) ?? null);
    if (outcome.billings.length) {
      await tx.insert(poLineBillings).values(outcome.billings.map((b) => ({ orgId, poLineId: b.poLineId, invoiceId, invoiceLineId: b.invoiceLineId, checkRunId, quantity: b.quantity, amount: b.amount, active: true })));
    }

    const [{ open } = { open: 0 }] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(exceptions)
      .where(and(eq(exceptions.invoiceId, invoiceId), inArray(exceptions.status, ["open", "in_review"])));
    const invoiceStatus = open > 0 ? "exceptions_open" : "passed";
    await tx.update(invoices).set({ status: invoiceStatus, failureReason: null, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    await audit(tx, {
      orgId,
      actorUserId: null,
      actorType: "system",
      action: "check.completed",
      entityType: "invoice",
      entityId: invoiceId,
      data: {
        checkRunId,
        revision,
        ruleSetVersion: RULE_SET_VERSION,
        discrepancies: outcome.findings.length,
        types: [...new Set(outcome.findings.map((f) => f.type))],
        billings: outcome.billings.length,
        supersededRunIds: superseded.map((s) => s.id),
        invoiceStatus,
      },
    });
    return { status: "completed", checkRunId, reused: false, discrepancies: outcome.findings.length, invoiceStatus };
  });
}

async function insertFinding(tx: Tx, orgId: string, invoiceId: string, checkRunId: string, f: Finding, assigneeUserId: string | null) {
  const [d] = await tx
    .insert(discrepancies)
    .values({
      orgId,
      checkRunId,
      invoiceId,
      invoiceLineId: f.invoiceLineId,
      type: f.type,
      severity: f.severity,
      expectedValue: f.expectedValue,
      actualValue: f.actualValue,
      amount: f.amount,
      currency: f.currency,
      explanation: f.explanation,
      references: f.references,
    })
    .returning({ id: discrepancies.id });
  const [ex] = await tx
    .insert(exceptions)
    .values({ orgId, invoiceId, discrepancyId: d!.id, kind: "discrepancy", title: f.title.slice(0, 300), assigneeUserId })
    .onConflictDoNothing({ target: exceptions.discrepancyId })
    .returning({ id: exceptions.id });
  if (ex) await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "exception.created", entityType: "exception", entityId: ex.id, data: { kind: "discrepancy", type: f.type, discrepancyId: d!.id, checkRunId, carriedAssignee: assigneeUserId } });
}

async function loadDuplicateCandidates(tx: Tx, inv: typeof invoices.$inferSelect, supplierId: string | null, sha: string | null): Promise<DuplicateCandidate[]> {
  const conds = [eq(invoices.documentId, inv.documentId)];
  if (sha) conds.push(eq(documents.sha256, sha));
  if (supplierId) {
    const num = normId(inv.invoiceNumber);
    if (num) conds.push(and(eq(invoices.supplierId, supplierId), sql`regexp_replace(upper(coalesce(${invoices.invoiceNumber}, '')), '[^A-Z0-9]', '', 'g') = ${num}`)!);
    if (inv.invoiceDate && inv.total) conds.push(and(eq(invoices.supplierId, supplierId), eq(invoices.invoiceDate, inv.invoiceDate), sql`abs(${invoices.total}) = abs(${inv.total}::numeric)`)!);
  }
  const rows = await tx
    .select({
      id: invoices.id,
      kind: invoices.kind,
      supplierId: invoices.supplierId,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      total: invoices.total,
      documentId: invoices.documentId,
      documentSha256: documents.sha256,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(documents, eq(documents.id, invoices.documentId))
    .where(and(ne(invoices.id, inv.id), ne(invoices.status, "rejected"), or(...conds)))
    .limit(50);
  return rows;
}

/** Record a terminal processing failure so it is visible and recoverable (Settings → failed jobs → Retry). */
export async function recordProcessingFailure(orgId: string, invoiceId: string, stage: "matching" | "checking", message: string) {
  await withTenant(orgId, async (tx) => {
    const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!inv) return;
    const reason = `${stage} failed: ${message}`.slice(0, 1000);
    await tx.update(invoices).set({ status: "failed", failureReason: reason, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    const [open] = await tx
      .select({ id: exceptions.id })
      .from(exceptions)
      .where(and(eq(exceptions.invoiceId, invoiceId), eq(exceptions.kind, "processing_failure"), inArray(exceptions.status, ["open", "in_review"])));
    if (!open) {
      const [ex] = await tx.insert(exceptions).values({ orgId, invoiceId, kind: "processing_failure", title: `Invoice ${stage} failed` }).returning({ id: exceptions.id });
      await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "exception.created", entityType: "exception", entityId: ex!.id, data: { kind: "processing_failure", stage } });
    }
    await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "invoice.processing_failed", entityType: "invoice", entityId: invoiceId, data: { stage, error: message.slice(0, 1000) } });
  });
}

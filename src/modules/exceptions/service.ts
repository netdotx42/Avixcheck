import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { checkRuns, discrepancies, exceptions, invoices, memberships } from "@/db/schema";
import type { Tx } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { assertCan, can, type Role } from "@/lib/auth/permissions";
import { dec, isDecimalString } from "@/lib/money/decimal";
import { DomainError } from "@/lib/orgs";
import {
  DECISION_STATUS,
  decisionsFor,
  hasExposure,
  invoiceOutcome,
  isDecidable,
  permissionFor,
  reasonRequired,
  type Decision,
  type ExceptionKind,
  type ExceptionStatus,
  type InvoiceStatus,
} from "./rules";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

/** Someone else changed the exception since it was loaded. The caller should reload and retry. */
export class ConflictError extends Error {
  readonly status = 409;
  constructor(message = "This exception was changed by someone else. Reload to see the latest version.") {
    super(message);
    this.name = "ConflictError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BULK = 200;

function assertUuid(v: string, what: string) {
  if (!UUID_RE.test(v)) throw new DomainError(`Invalid ${what}`, "invalid_id");
}

function cleanReason(reason: string | null | undefined, required: boolean): string | null {
  const r = (reason ?? "").trim();
  if (!r) {
    if (required) throw new DomainError("A reason is required for this decision", "reason_required");
    return null;
  }
  if (r.length < 3) throw new DomainError("Reason must be at least 3 characters", "reason_too_short");
  if (r.length > 2000) throw new DomainError("Reason must be at most 2000 characters", "reason_too_long");
  return r;
}

async function loadException(tx: Tx, id: string) {
  const [row] = await tx
    .select({ e: exceptions, amount: discrepancies.amount, currency: discrepancies.currency, discrepancyType: discrepancies.type })
    .from(exceptions)
    .leftJoin(discrepancies, eq(discrepancies.id, exceptions.discrepancyId))
    .where(eq(exceptions.id, id));
  if (!row) throw new DomainError("Exception not found", "not_found");
  return row;
}

/** Assignees must be members who can act on exceptions (Admin or Reviewer). */
async function assertAssignable(tx: Tx, orgId: string, userId: string) {
  const [m] = await tx.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  if (!m) throw new DomainError("Assignee is not a member of this organisation", "invalid_assignee");
  if (!can(m.role, "exception.decide")) throw new DomainError("Viewers cannot be assigned exceptions", "invalid_assignee");
}

/**
 * Apply an optimistic update: succeeds only if the row is still at `revision`.
 * Revision is bumped on every change so concurrent edits never silently overwrite each other.
 */
async function updateAtRevision(tx: Tx, id: string, revision: number, set: Partial<typeof exceptions.$inferInsert>) {
  const rows = await tx
    .update(exceptions)
    .set({ ...set, revision: sql`${exceptions.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(exceptions.id, id), eq(exceptions.revision, revision)))
    .returning();
  if (!rows[0]) throw new ConflictError();
  return rows[0];
}

export async function assignException(actor: Actor, input: { exceptionId: string; revision: number; assigneeUserId: string | null }) {
  assertCan(actor.role, "exception.assign");
  assertUuid(input.exceptionId, "exception id");
  if (input.assigneeUserId) assertUuid(input.assigneeUserId, "assignee");
  return withTenant(actor.orgId, async (tx) => {
    const { e } = await loadException(tx, input.exceptionId);
    if (!isDecidable(e.status)) throw new DomainError("Decided exceptions cannot be reassigned", "already_decided");
    if (input.assigneeUserId) await assertAssignable(tx, actor.orgId, input.assigneeUserId);
    const updated = await updateAtRevision(tx, e.id, input.revision, { assigneeUserId: input.assigneeUserId });
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "exception.assigned",
      entityType: "exception",
      entityId: e.id,
      data: { from: e.assigneeUserId, to: input.assigneeUserId, revision: updated.revision },
    });
    return updated;
  });
}

/**
 * Assign many exceptions at once. Each item carries the revision the user saw;
 * stale or already-decided items are skipped and reported rather than overwritten.
 */
export async function bulkAssign(actor: Actor, input: { items: { id: string; revision: number }[]; assigneeUserId: string | null }) {
  assertCan(actor.role, "exception.assign");
  if (input.items.length === 0) throw new DomainError("Select at least one exception", "empty_selection");
  if (input.items.length > MAX_BULK) throw new DomainError(`Assign at most ${MAX_BULK} exceptions at a time`, "too_many");
  input.items.forEach((i) => assertUuid(i.id, "exception id"));
  if (input.assigneeUserId) assertUuid(input.assigneeUserId, "assignee");
  return withTenant(actor.orgId, async (tx) => {
    if (input.assigneeUserId) await assertAssignable(tx, actor.orgId, input.assigneeUserId);
    const ids = [...new Set(input.items.map((i) => i.id))];
    const current = await tx.select().from(exceptions).where(inArray(exceptions.id, ids)).for("update");
    const byId = new Map(current.map((c) => [c.id, c]));
    const assigned: string[] = [];
    const skipped: { id: string; reason: "not_found" | "stale" | "decided" }[] = [];
    for (const item of input.items) {
      const e = byId.get(item.id);
      if (!e) skipped.push({ id: item.id, reason: "not_found" });
      else if (!isDecidable(e.status)) skipped.push({ id: item.id, reason: "decided" });
      else if (e.revision !== item.revision) skipped.push({ id: item.id, reason: "stale" });
      else if (!assigned.includes(e.id)) {
        await updateAtRevision(tx, e.id, item.revision, { assigneeUserId: input.assigneeUserId });
        await audit(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          action: "exception.assigned",
          entityType: "exception",
          entityId: e.id,
          data: { from: e.assigneeUserId, to: input.assigneeUserId, bulk: true },
        });
        assigned.push(e.id);
      }
    }
    return { assigned, skipped };
  });
}

/** Move an open exception into review. Unassigned exceptions are assigned to the reviewer. */
export async function startReview(actor: Actor, input: { exceptionId: string; revision: number }) {
  assertCan(actor.role, "exception.decide");
  assertUuid(input.exceptionId, "exception id");
  return withTenant(actor.orgId, async (tx) => {
    const { e } = await loadException(tx, input.exceptionId);
    if (e.status !== "open") throw new DomainError("Only open exceptions can be moved into review", "invalid_state");
    const updated = await updateAtRevision(tx, e.id, input.revision, { status: "in_review", assigneeUserId: e.assigneeUserId ?? actor.userId });
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "exception.review_started",
      entityType: "exception",
      entityId: e.id,
      data: { assigneeUserId: updated.assigneeUserId },
    });
    return updated;
  });
}

export interface DecideInput {
  exceptionId: string;
  revision: number;
  decision: Decision;
  reason?: string | null;
  /** Explicit acknowledgement required when accepting a variance that carries exposure. */
  confirmAboveTolerance?: boolean;
}

export async function decideException(actor: Actor, input: DecideInput) {
  assertCan(actor.role, "exception.decide");
  assertUuid(input.exceptionId, "exception id");
  if (!(input.decision in DECISION_STATUS)) throw new DomainError("Unknown decision", "invalid_decision");
  const reason = cleanReason(input.reason, reasonRequired(input.decision));
  return withTenant(actor.orgId, async (tx) => {
    const first = await loadException(tx, input.exceptionId);
    // Lock order: invoice, then exception, matching the check engine.
    await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, first.e.invoiceId)).for("update");
    const { e, amount, currency, discrepancyType } = await loadException(tx, input.exceptionId);
    if (e.revision !== input.revision) throw new ConflictError();
    if (!isDecidable(e.status)) throw new DomainError("This exception has already been decided", "already_decided");
    if (!decisionsFor(e.kind).includes(input.decision)) throw new DomainError("That decision does not apply to this kind of exception", "invalid_decision");
    assertCan(actor.role, permissionFor(input.decision, { kind: e.kind, amount }));
    const aboveTolerance = e.kind === "discrepancy" && hasExposure(amount);
    if (input.decision === "accept_variance" && aboveTolerance && !input.confirmAboveTolerance) {
      throw new DomainError("Confirm that you authorise accepting a variance above tolerance", "confirmation_required");
    }
    const status = DECISION_STATUS[input.decision];
    const updated = await updateAtRevision(tx, e.id, input.revision, {
      status,
      decisionReason: reason,
      decidedBy: actor.userId,
      decidedAt: new Date(),
      assigneeUserId: e.assigneeUserId ?? actor.userId,
    });
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "exception.decided",
      entityType: "exception",
      entityId: e.id,
      data: {
        decision: input.decision,
        from: e.status,
        to: status,
        reason,
        kind: e.kind,
        discrepancyType,
        amount,
        currency,
        aboveTolerance,
        invoiceId: e.invoiceId,
      },
    });
    const invoiceStatus = await recomputeInvoiceStatus(tx, actor.orgId, e.invoiceId, actor.userId);
    return { exception: updated, invoiceStatus };
  });
}

/**
 * Record the supplier's confirmed correction against a "correction requested"
 * exception. This is the only source of realised savings; discrepancy amounts
 * are potential exposure.
 */
export async function recordConfirmedCorrection(actor: Actor, input: { exceptionId: string; revision: number; amount: string; reference: string }) {
  assertCan(actor.role, "exception.decide");
  assertUuid(input.exceptionId, "exception id");
  const amountStr = (input.amount ?? "").trim();
  if (!isDecimalString(amountStr)) throw new DomainError("Enter the corrected amount as a number, e.g. 125.40", "invalid_amount");
  const amount = dec(amountStr);
  if (amount.lte(0)) throw new DomainError("Corrected amount must be greater than zero", "invalid_amount");
  if (amount.decimalPlaces() > 4) throw new DomainError("Corrected amount can have at most 4 decimal places", "invalid_amount");
  if (amount.gte("1e16")) throw new DomainError("Corrected amount is too large", "invalid_amount");
  const reference = (input.reference ?? "").trim();
  if (reference.length < 1 || reference.length > 200) throw new DomainError("Enter the credit note or corrected invoice reference (max 200 characters)", "invalid_reference");
  return withTenant(actor.orgId, async (tx) => {
    const first = await loadException(tx, input.exceptionId);
    await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, first.e.invoiceId)).for("update");
    const { e, currency } = await loadException(tx, input.exceptionId);
    if (e.revision !== input.revision) throw new ConflictError();
    if (e.status !== "correction_requested") throw new DomainError("A confirmed correction can only be recorded after requesting one", "invalid_state");
    if (e.confirmedCorrectionAmount !== null) throw new DomainError("A confirmed correction is already recorded", "already_recorded");
    const fixed = amount.toFixed(4);
    const updated = await updateAtRevision(tx, e.id, input.revision, { confirmedCorrectionAmount: fixed, confirmedCorrectionRef: reference });
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "exception.correction_confirmed",
      entityType: "exception",
      entityId: e.id,
      data: { amount: fixed, currency, reference, invoiceId: e.invoiceId },
    });
    const invoiceStatus = await recomputeInvoiceStatus(tx, actor.orgId, e.invoiceId, actor.userId);
    return { exception: updated, invoiceStatus };
  });
}

/**
 * Recompute an invoice's status from its exceptions. Call inside the tenant
 * transaction that changed an exception. Discrepancy exceptions from
 * superseded check runs no longer apply and are ignored.
 */
export async function recomputeInvoiceStatus(tx: Tx, orgId: string, invoiceId: string, actorUserId: string | null): Promise<InvoiceStatus> {
  const [inv] = await tx.select({ id: invoices.id, status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!inv) throw new DomainError("Invoice not found", "not_found");
  const [latestRun] = await tx
    .select({ id: checkRuns.id, status: checkRuns.status })
    .from(checkRuns)
    .where(and(eq(checkRuns.invoiceId, invoiceId), sql`${checkRuns.status} <> 'superseded'`))
    .orderBy(desc(checkRuns.startedAt))
    .limit(1);
  const rows = await tx
    .select({ kind: exceptions.kind, status: exceptions.status, confirmedCorrectionAmount: exceptions.confirmedCorrectionAmount, runStatus: checkRuns.status })
    .from(exceptions)
    .leftJoin(discrepancies, eq(discrepancies.id, exceptions.discrepancyId))
    .leftJoin(checkRuns, eq(checkRuns.id, discrepancies.checkRunId))
    .where(eq(exceptions.invoiceId, invoiceId));
  const applicable = rows.filter((r) => !(r.kind === "discrepancy" && r.runStatus === "superseded"));
  const next = invoiceOutcome({
    invoiceStatus: inv.status,
    hasCompletedCheckRun: latestRun?.status === "completed",
    exceptions: applicable.map((r) => ({ kind: r.kind as ExceptionKind, status: r.status as ExceptionStatus, confirmedCorrectionAmount: r.confirmedCorrectionAmount })),
  });
  if (!next) return inv.status;
  await tx.update(invoices).set({ status: next, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  await audit(tx, {
    orgId,
    actorUserId,
    action: "invoice.status_changed",
    entityType: "invoice",
    entityId: invoiceId,
    data: { from: inv.status, to: next, cause: "exception_review" },
  });
  return next;
}

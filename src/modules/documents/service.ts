import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { documents, exceptions, invoices, jobs, organizations } from "@/db/schema";
import type { Tx } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { env } from "@/env";
import { audit } from "@/lib/audit";
import { assertCan, type Role } from "@/lib/auth/permissions";
import { enqueue } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES } from "@/lib/jobs/registry";
import { parseOrgSettings } from "@/lib/org-settings";
import { DomainError } from "@/lib/orgs";
import { objectKey } from "@/lib/storage";
import { deps } from "./deps";
import { checkPdf, safeFileName } from "./pdf";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
  requestId?: string | null;
}

export type ExceptionKind = (typeof exceptions.$inferInsert)["kind"];

export function sha256Hex(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function addDays(days: number, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}

export interface UploadResult {
  invoiceId: string;
  documentId: string;
  /** True when this exact file (same sha256) was already uploaded to the organisation. */
  duplicate: boolean;
}

/**
 * Store an uploaded PDF invoice and queue it for malware scanning.
 * Order: validate → dedupe by sha256 → write object → insert rows + job in one
 * transaction. A concurrent upload of the same file loses the unique
 * (org_id, sha256) race, deletes its object and returns the winner.
 */
export async function uploadInvoiceDocument(actor: Actor, file: { bytes: Buffer; name: string | null }): Promise<UploadResult> {
  assertCan(actor.role, "invoice.upload");
  const d = deps();
  if (!d.storage.configured()) throw new DomainError("Document storage is not configured, so uploads are disabled.", "storage_not_configured");
  const check = checkPdf(file.bytes, env().MAX_UPLOAD_BYTES);
  if (!check.ok) throw new DomainError(check.rejection.message, `pdf_${check.rejection.code}`);

  const sha = sha256Hex(file.bytes);
  const name = safeFileName(file.name);

  const existing = await findBySha(actor.orgId, sha);
  if (existing) return { ...existing, duplicate: true };

  const documentId = randomUUID();
  const key = objectKey(actor.orgId, "documents", documentId, "pdf");
  await d.storage.put(key, file.bytes, "application/pdf");

  const created = await withTenant(actor.orgId, async (tx) => {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    const settings = parseOrgSettings(org?.settings);
    const inserted = await tx
      .insert(documents)
      .values({
        id: documentId,
        orgId: actor.orgId,
        storageKey: key,
        sha256: sha,
        sizeBytes: file.bytes.length,
        mimeType: "application/pdf",
        originalName: name,
        uploadedBy: actor.userId,
        retainUntil: addDays(settings.retention.documentDays),
      })
      .onConflictDoNothing({ target: [documents.orgId, documents.sha256] })
      .returning({ id: documents.id });
    if (!inserted[0]) return null;
    const [inv] = await tx
      .insert(invoices)
      .values({ orgId: actor.orgId, documentId, status: "uploaded", createdBy: actor.userId })
      .returning({ id: invoices.id });
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "document.uploaded",
      entityType: "invoice",
      entityId: inv!.id,
      data: { documentId, sha256: sha, sizeBytes: file.bytes.length, originalName: name },
      requestId: actor.requestId,
    });
    await enqueue(tx, {
      orgId: actor.orgId,
      type: JOB_TYPES.scanDocument,
      payload: { documentId, invoiceId: inv!.id },
      idempotencyKey: idempotencyKey(actor.orgId, JOB_TYPES.scanDocument, documentId),
      createdBy: actor.userId,
    });
    return { invoiceId: inv!.id, documentId };
  }).catch(async (err) => {
    await d.storage.delete(key).catch(() => undefined);
    throw err;
  });

  if (!created) {
    // Lost a concurrent race for the same file: remove our copy, return the original.
    await d.storage.delete(key).catch(() => undefined);
    const winner = await findBySha(actor.orgId, sha);
    if (!winner) throw new Error("Duplicate document detected but the original could not be found");
    return { ...winner, duplicate: true };
  }
  return { ...created, duplicate: false };
}

async function findBySha(orgId: string, sha: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ invoiceId: invoices.id, documentId: documents.id })
      .from(documents)
      .innerJoin(invoices, eq(invoices.documentId, documents.id))
      .where(eq(documents.sha256, sha))
      .orderBy(invoices.createdAt)
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Open (or keep) one unresolved exception of a non-discrepancy kind per invoice.
 * Callers hold the invoice row lock, so retries and concurrent jobs cannot
 * create duplicates.
 */
export async function ensureOpenException(tx: Tx, orgId: string, invoiceId: string, kind: Exclude<ExceptionKind, "discrepancy">, title: string) {
  const open = await tx
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(and(eq(exceptions.invoiceId, invoiceId), eq(exceptions.kind, kind), inArray(exceptions.status, ["open", "in_review"])))
    .limit(1);
  if (open[0]) {
    await tx.update(exceptions).set({ title, updatedAt: new Date() }).where(eq(exceptions.id, open[0].id));
    return { id: open[0].id, created: false };
  }
  const [row] = await tx.insert(exceptions).values({ orgId, invoiceId, kind, title }).returning({ id: exceptions.id });
  await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "exception.opened", entityType: "exception", entityId: row!.id, data: { invoiceId, kind, title } });
  return { id: row!.id, created: true };
}

/** Lock an invoice row for the rest of the transaction. */
export async function lockInvoice(tx: Tx, invoiceId: string) {
  await tx.execute(sql`select id from invoices where id = ${invoiceId} for update`);
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  return inv ?? null;
}

/** Mark an invoice as failed with a visible reason and a processing_failure exception. */
export async function recordProcessingFailure(tx: Tx, orgId: string, invoiceId: string, reason: string) {
  await tx.update(invoices).set({ status: "failed", failureReason: reason.slice(0, 1000), updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  await ensureOpenException(tx, orgId, invoiceId, "processing_failure", `Processing failed: ${reason.slice(0, 200)}`);
  await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "invoice.processing_failed", entityType: "invoice", entityId: invoiceId, data: { reason } });
}

const RESTART_STATUS: Record<string, "uploaded" | "extracting"> = {
  [JOB_TYPES.scanDocument]: "uploaded",
  [JOB_TYPES.extractInvoice]: "extracting",
};

/**
 * Admin recovery for an invoice whose scan or extraction job failed: re-queue
 * the failed job(s) with a fresh retry budget and move the invoice back to the
 * stage that job handles. Quarantined invoices cannot be retried.
 */
export async function retryInvoiceProcessing(actor: Actor, invoiceId: string) {
  assertCan(actor.role, "jobs.recover");
  return withTenant(actor.orgId, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    if (!inv) throw new DomainError("Invoice not found", "not_found");
    if (inv.status === "quarantined") throw new DomainError("Quarantined documents are never reprocessed.", "quarantined");
    const failed = await tx
      .select({ id: jobs.id, type: jobs.type })
      .from(jobs)
      .where(and(inArray(jobs.status, ["failed", "cancelled"]), inArray(jobs.type, Object.keys(RESTART_STATUS)), sql`${jobs.payload}->>'invoiceId' = ${invoiceId}`));
    if (failed.length === 0) throw new DomainError("There is no failed processing job to retry for this invoice.", "nothing_to_retry");
    const restart = failed.some((j) => j.type === JOB_TYPES.scanDocument) ? "uploaded" : "extracting";
    for (const j of failed) {
      await tx
        .update(jobs)
        .set({ status: "queued", runAfter: new Date(), maxAttempts: sql`${jobs.attempts} + 3`, finishedAt: null, updatedAt: new Date() })
        .where(eq(jobs.id, j.id));
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "job.retried", entityType: "job", entityId: j.id, data: { type: j.type, invoiceId }, requestId: actor.requestId });
    }
    if (restart === "uploaded") {
      await tx.update(documents).set({ scanStatus: "pending", scanDetail: null }).where(and(eq(documents.id, inv.documentId), inArray(documents.scanStatus, ["pending", "error"])));
    }
    await tx.update(invoices).set({ status: restart, failureReason: null, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    const dismissed = await tx
      .update(exceptions)
      .set({ status: "dismissed", decisionReason: "Processing retried by an admin", decidedBy: actor.userId, decidedAt: new Date(), revision: sql`${exceptions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(exceptions.invoiceId, invoiceId), eq(exceptions.kind, "processing_failure"), inArray(exceptions.status, ["open", "in_review"])))
      .returning({ id: exceptions.id });
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "invoice.processing_retried", entityType: "invoice", entityId: invoiceId, data: { jobs: failed.map((j) => j.id), restartAt: restart, dismissedExceptions: dismissed.map((e) => e.id) }, requestId: actor.requestId });
    return { retried: failed.length, status: restart };
  });
}

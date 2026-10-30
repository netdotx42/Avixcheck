import { and, eq, inArray } from "drizzle-orm";
import { documents, invoices } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES, registerHandler, type JobContext } from "@/lib/jobs/registry";
import { assertKeyInOrg } from "@/lib/storage";
import { deps } from "./deps";
import { ensureOpenException, lockInvoice, recordProcessingFailure, sha256Hex } from "./service";

export const SCAN_NOT_CONFIGURED =
  "Malware scanning is not configured (CLAMAV_HOST is missing). The document is held unscanned and will not be processed until scanning is set up and the job is retried.";

function payloadIds(ctx: JobContext) {
  const p = (ctx.job.payload ?? {}) as { documentId?: unknown; invoiceId?: unknown };
  if (typeof p.documentId !== "string" || typeof p.invoiceId !== "string") throw new PermanentJobError("Job payload is missing documentId/invoiceId");
  return { documentId: p.documentId, invoiceId: p.invoiceId };
}

const isFinalAttempt = (ctx: JobContext) => ctx.job.attempts >= ctx.job.maxAttempts;

/**
 * document.scan — ClamAV scan of the stored bytes. Clean → queue extraction.
 * Infected → quarantine. Never treats "not scanned" as clean. Idempotent: a
 * document already scanned is not rescanned, and the follow-up job key is fixed.
 */
export async function handleScanDocument(ctx: JobContext) {
  const { orgId } = ctx;
  const { documentId, invoiceId } = payloadIds(ctx);
  const d = deps();

  const doc = await withTenant(orgId, async (tx) => (await tx.select().from(documents).where(eq(documents.id, documentId)))[0]);
  if (!doc) throw new PermanentJobError("Document not found in this organisation");
  if (doc.scanStatus === "infected") return { status: "already_quarantined" };

  if (doc.scanStatus !== "clean") {
    if (!d.scanner.configured()) {
      await withTenant(orgId, async (tx) => {
        await tx.update(documents).set({ scanDetail: SCAN_NOT_CONFIGURED }).where(eq(documents.id, documentId));
        await tx
          .update(invoices)
          .set({ status: "scanning", failureReason: SCAN_NOT_CONFIGURED, updatedAt: new Date() })
          .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, ["uploaded", "scanning"])));
      });
      throw new PermanentJobError(SCAN_NOT_CONFIGURED);
    }

    await withTenant(orgId, (tx) =>
      tx.update(invoices).set({ status: "scanning", failureReason: null, updatedAt: new Date() }).where(and(eq(invoices.id, invoiceId), eq(invoices.status, "uploaded"))),
    );

    assertKeyInOrg(orgId, doc.storageKey);
    const bytes = await d.storage.get(doc.storageKey);
    if (sha256Hex(bytes) !== doc.sha256) {
      await withTenant(orgId, async (tx) => {
        await lockInvoice(tx, invoiceId);
        await tx.update(documents).set({ scanStatus: "error", scanDetail: "Stored object does not match the uploaded file hash" }).where(eq(documents.id, documentId));
        await recordProcessingFailure(tx, orgId, invoiceId, "The stored document does not match the uploaded file (hash mismatch). Re-upload the invoice.");
      });
      throw new PermanentJobError("Stored object hash mismatch");
    }

    const result = await d.scanner.scan(bytes);
    if (result.status === "error") {
      if (isFinalAttempt(ctx)) {
        await withTenant(orgId, async (tx) => {
          await lockInvoice(tx, invoiceId);
          await tx.update(documents).set({ scanStatus: "error", scanDetail: result.detail.slice(0, 500) }).where(eq(documents.id, documentId));
          await recordProcessingFailure(tx, orgId, invoiceId, `Malware scan could not complete: ${result.detail}`);
        });
      }
      throw new Error(`Malware scan error: ${result.detail}`);
    }

    if (result.status === "infected") {
      await withTenant(orgId, async (tx) => {
        await lockInvoice(tx, invoiceId);
        await tx.update(documents).set({ scanStatus: "infected", scanDetail: result.signature.slice(0, 300), scannedAt: new Date() }).where(eq(documents.id, documentId));
        await tx.update(invoices).set({ status: "quarantined", failureReason: `Malware detected: ${result.signature}`, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
        await ensureOpenException(tx, orgId, invoiceId, "processing_failure", `Malware detected in uploaded document (${result.signature.slice(0, 120)})`);
        await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "document.quarantined", entityType: "document", entityId: documentId, data: { invoiceId, signature: result.signature } });
      });
      return { status: "infected" };
    }
  }

  // Clean (now or on an earlier attempt): advance to extraction exactly once.
  await withTenant(orgId, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    if (!inv) throw new PermanentJobError("Invoice not found");
    if (doc.scanStatus !== "clean") {
      await tx.update(documents).set({ scanStatus: "clean", scanDetail: null, scannedAt: new Date() }).where(eq(documents.id, documentId));
      await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "document.scanned", entityType: "document", entityId: documentId, data: { invoiceId, result: "clean" } });
    }
    if (inv.status === "uploaded" || inv.status === "scanning") {
      await tx.update(invoices).set({ status: "extracting", failureReason: null, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    }
    await enqueue(tx, {
      orgId,
      type: JOB_TYPES.extractInvoice,
      payload: { invoiceId, documentId },
      idempotencyKey: idempotencyKey(orgId, JOB_TYPES.extractInvoice, invoiceId),
    });
  });
  return { status: "clean" };
}

registerHandler(JOB_TYPES.scanDocument, handleScanDocument);

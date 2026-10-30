import { eq } from "drizzle-orm";
import { documents, invoiceLines, invoices, organizations } from "@/db/schema";
import type { Tx } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES, registerHandler, type JobContext } from "@/lib/jobs/registry";
import { parseOrgSettings } from "@/lib/org-settings";
import { assertKeyInOrg } from "@/lib/storage";
import { deps } from "@/modules/documents/deps";
import { ensureOpenException, lockInvoice, recordProcessingFailure } from "@/modules/documents/service";
import { EXTRACTION_SCHEMA_VERSION, normalizeExtraction } from "./schema";
import { ExtractionTransientError, type ProviderResult } from "./types";

export function extractionNotConfiguredReason(missing: string[]) {
  return `AI extraction is not configured (missing: ${missing.join(", ") || "provider settings"}). The invoice is waiting and will be extracted once it is set up and the job is retried.`;
}

/** Stored in invoices.extraction_raw for audit. Never used as a source of truth without validation. */
export interface ExtractionRecord {
  schemaVersion: string;
  provider: string;
  model: string;
  extractedAt: string;
  outcome: "extracted" | "needs_review" | "incomplete" | "invalid_output";
  output: unknown;
  confidence: string | null;
  issues: string[];
  warnings: string[];
  usage?: Record<string, unknown>;
}

/**
 * invoice.extract — send the clean PDF to the extraction provider, validate the
 * output, write header + lines, then route: confident and complete → matching;
 * anything uncertain → extraction_review with an exception. Idempotent: only
 * acts while the invoice is in `extracting`; the follow-up job key is per revision.
 */
export async function handleExtractInvoice(ctx: JobContext) {
  const { orgId } = ctx;
  const p = (ctx.job.payload ?? {}) as { invoiceId?: unknown };
  if (typeof p.invoiceId !== "string") throw new PermanentJobError("Job payload is missing invoiceId");
  const invoiceId = p.invoiceId;
  const d = deps();

  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select({ invoice: invoices, doc: documents })
      .from(invoices)
      .innerJoin(documents, eq(documents.id, invoices.documentId))
      .where(eq(invoices.id, invoiceId));
    return r;
  });
  if (!row) throw new PermanentJobError("Invoice not found in this organisation");
  if (row.invoice.status !== "extracting") return { skipped: true, status: row.invoice.status };
  if (row.doc.scanStatus !== "clean") throw new PermanentJobError("Refusing to extract a document that has not passed malware scanning");

  if (!d.extractor.configured()) {
    const reason = extractionNotConfiguredReason(d.extractor.missing());
    await withTenant(orgId, (tx) => tx.update(invoices).set({ failureReason: reason, updatedAt: new Date() }).where(eq(invoices.id, invoiceId)));
    throw new PermanentJobError(reason);
  }

  assertKeyInOrg(orgId, row.doc.storageKey);
  const bytes = await d.storage.get(row.doc.storageKey);

  let result: ProviderResult;
  try {
    result = await d.extractor.extract(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transient = err instanceof ExtractionTransientError;
    if (!transient || ctx.job.attempts >= ctx.job.maxAttempts) {
      await withTenant(orgId, async (tx) => {
        const inv = await lockInvoice(tx, invoiceId);
        if (inv?.status === "extracting") await recordProcessingFailure(tx, orgId, invoiceId, `Extraction failed: ${message}`);
      });
      if (!transient) throw new PermanentJobError(`Extraction failed: ${message}`);
    }
    throw err;
  }

  return withTenant(orgId, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    if (!inv || inv.status !== "extracting") return { skipped: true, status: inv?.status };
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    const settings = parseOrgSettings(org?.settings);

    const base = { schemaVersion: EXTRACTION_SCHEMA_VERSION, provider: d.extractor.name, model: result.model, extractedAt: new Date().toISOString(), usage: result.kind === "ok" ? result.usage : undefined };

    if (result.kind === "incomplete") {
      const record: ExtractionRecord = { ...base, outcome: "incomplete", output: result.output ?? null, confidence: null, issues: [result.reason], warnings: [] };
      return routeToReview(tx, orgId, invoiceId, record, null);
    }

    const normalized = normalizeExtraction(result.output, settings.review.minExtractionConfidence);
    if (!normalized.ok) {
      const record: ExtractionRecord = { ...base, outcome: "invalid_output", output: result.output, confidence: null, issues: ["The extraction output did not match the expected structure.", ...normalized.issues], warnings: [] };
      return routeToReview(tx, orgId, invoiceId, record, null);
    }

    const n = normalized.result;
    const h = n.header;
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    if (n.lines.length > 0) {
      await tx.insert(invoiceLines).values(n.lines.map((l) => ({ ...l, orgId, invoiceId })));
    }
    const record: ExtractionRecord = { ...base, outcome: n.issues.length ? "needs_review" : "extracted", output: result.output, confidence: n.confidence, issues: n.issues, warnings: n.warnings };
    await tx
      .update(invoices)
      .set({
        kind: h.kind,
        supplierNameRaw: h.supplierNameRaw,
        supplierTaxIdRaw: h.supplierTaxId,
        invoiceNumber: h.invoiceNumber,
        invoiceDate: h.invoiceDate,
        dueDate: h.dueDate,
        currency: h.currency,
        poNumberRaw: h.poNumberRaw,
        creditsInvoiceNumberRaw: h.creditedInvoiceNumber,
        subtotal: h.subtotal,
        taxTotal: h.taxTotal,
        total: h.total,
        extractionConfidence: n.confidence,
        extractionModel: result.model,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId));

    if (n.issues.length > 0) return routeToReview(tx, orgId, invoiceId, record, n.confidence);

    await tx.update(invoices).set({ status: "matching", extractionRaw: record, failureReason: null }).where(eq(invoices.id, invoiceId));
    await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "invoice.extracted", entityType: "invoice", entityId: invoiceId, data: { model: result.model, confidence: n.confidence, lines: n.lines.length, schemaVersion: EXTRACTION_SCHEMA_VERSION, outcome: "extracted" } });
    await enqueue(tx, { orgId, type: JOB_TYPES.matchInvoice, payload: { invoiceId, revision: inv.revision }, idempotencyKey: idempotencyKey(orgId, JOB_TYPES.matchInvoice, invoiceId, inv.revision) });
    return { status: "matching", confidence: n.confidence };
  });
}

async function routeToReview(tx: Tx, orgId: string, invoiceId: string, record: ExtractionRecord, confidence: string | null) {
  await tx.update(invoices).set({ status: "extraction_review", extractionRaw: record, extractionModel: record.model, extractionConfidence: confidence, failureReason: null, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  const title = `Check extracted values: ${record.issues[0] ?? "uncertain extraction"}`.slice(0, 300);
  await ensureOpenException(tx, orgId, invoiceId, "extraction_review", title);
  await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "invoice.extracted", entityType: "invoice", entityId: invoiceId, data: { model: record.model, confidence, outcome: record.outcome, issues: record.issues.slice(0, 20), schemaVersion: record.schemaVersion } });
  return { status: "extraction_review", issues: record.issues.length };
}

registerHandler(JOB_TYPES.extractInvoice, handleExtractInvoice);

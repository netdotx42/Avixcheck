import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { documents, exceptions, invoiceLines, invoices, jobs, suppliers } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { Tone } from "@/components/ui/status-badge";

export type InvoiceStatus = (typeof invoices.$inferSelect)["status"];

export const STATUS_META: Record<InvoiceStatus, { label: string; tone: Tone; hint: string }> = {
  uploaded: { label: "Uploaded", tone: "neutral", hint: "Waiting for malware scan." },
  scanning: { label: "Scanning", tone: "progress", hint: "Malware scan in progress." },
  quarantined: { label: "Quarantined", tone: "danger", hint: "Malware detected. The file is never processed or served." },
  extracting: { label: "Extracting", tone: "progress", hint: "Reading header and line items." },
  extraction_review: { label: "Needs review", tone: "warn", hint: "Extraction was uncertain or incomplete. Check and correct the values." },
  matching: { label: "Matching", tone: "progress", hint: "Matching to supplier, purchase order and agreements." },
  matching_review: { label: "Match review", tone: "warn", hint: "Supplier or PO match is uncertain." },
  checking: { label: "Checking", tone: "progress", hint: "Running financial checks." },
  exceptions_open: { label: "Exceptions", tone: "warn", hint: "Checks found discrepancies to review." },
  passed: { label: "Passed checks", tone: "ok", hint: "All checks passed. This is not payment approval." },
  failed: { label: "Failed", tone: "danger", hint: "Processing failed. See the reason and recover." },
  rejected: { label: "Rejected", tone: "danger", hint: "Rejected by a reviewer." },
};

/** Status filter groups shown on the list page. */
export const STATUS_FILTERS: Record<string, { label: string; statuses: InvoiceStatus[] }> = {
  processing: { label: "Processing", statuses: ["uploaded", "scanning", "extracting", "matching", "checking"] },
  review: { label: "Needs review", statuses: ["extraction_review", "matching_review"] },
  exceptions: { label: "Exceptions", statuses: ["exceptions_open"] },
  passed: { label: "Passed checks", statuses: ["passed"] },
  failed: { label: "Failed / quarantined", statuses: ["failed", "quarantined"] },
  rejected: { label: "Rejected", statuses: ["rejected"] },
};

export const PAGE_SIZE = 25;

export async function listInvoices(orgId: string, opts: { q?: string; filter?: string; page: number }) {
  const conds: SQL[] = [];
  const q = opts.q?.trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(invoices.invoiceNumber, like), ilike(invoices.supplierNameRaw, like), ilike(suppliers.name, like), ilike(documents.originalName, like), ilike(invoices.poNumberRaw, like))!);
  }
  const f = opts.filter ? STATUS_FILTERS[opts.filter] : undefined;
  if (f) conds.push(inArray(invoices.status, f.statuses));
  const where = conds.length ? and(...conds) : undefined;

  return withTenant(orgId, async (tx) => {
    const base = tx
      .select({
        id: invoices.id,
        status: invoices.status,
        kind: invoices.kind,
        invoiceNumber: invoices.invoiceNumber,
        invoiceDate: invoices.invoiceDate,
        supplierName: sql<string | null>`coalesce(${suppliers.name}, ${invoices.supplierNameRaw})`,
        currency: invoices.currency,
        total: invoices.total,
        originalName: documents.originalName,
        createdAt: invoices.createdAt,
        failureReason: invoices.failureReason,
      })
      .from(invoices)
      .innerJoin(documents, eq(documents.id, invoices.documentId))
      .leftJoin(suppliers, eq(suppliers.id, invoices.supplierId))
      .where(where)
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(PAGE_SIZE)
      .offset((opts.page - 1) * PAGE_SIZE);
    const [rows, [totalRow]] = await Promise.all([
      base,
      tx.select({ n: count() }).from(invoices).innerJoin(documents, eq(documents.id, invoices.documentId)).leftJoin(suppliers, eq(suppliers.id, invoices.supplierId)).where(where),
    ]);
    return { rows, total: totalRow?.n ?? 0 };
  });
}

export async function getInvoiceDetail(orgId: string, invoiceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) return null;
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ invoice: invoices, doc: documents, supplierName: suppliers.name, supplierCode: suppliers.code })
      .from(invoices)
      .innerJoin(documents, eq(documents.id, invoices.documentId))
      .leftJoin(suppliers, eq(suppliers.id, invoices.supplierId))
      .where(eq(invoices.id, invoiceId));
    if (!row) return null;
    const [lines, openExceptions, failedJobs] = await Promise.all([
      tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo)),
      tx
        .select({ id: exceptions.id, kind: exceptions.kind, title: exceptions.title, status: exceptions.status })
        .from(exceptions)
        .where(and(eq(exceptions.invoiceId, invoiceId), inArray(exceptions.status, ["open", "in_review"])))
        .orderBy(desc(exceptions.createdAt))
        .limit(20),
      tx
        .select({ id: jobs.id, type: jobs.type, lastError: jobs.lastError, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
        .from(jobs)
        .where(and(eq(jobs.status, "failed"), sql`${jobs.payload}->>'invoiceId' = ${invoiceId}`))
        .orderBy(desc(jobs.updatedAt))
        .limit(5),
    ]);
    return { ...row, lines, openExceptions, failedJobs };
  });
}

/**
 * Resolve a document for preview. Only documents in the caller's org (RLS) that
 * passed malware scanning and are not deleted can be served.
 */
export async function getPreviewableDocument(orgId: string, documentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return { ok: false as const, reason: "not_found" as const };
  const doc = await withTenant(orgId, async (tx) => (await tx.select().from(documents).where(eq(documents.id, documentId)))[0]);
  if (!doc || doc.deletedAt) return { ok: false as const, reason: "not_found" as const };
  if (doc.scanStatus !== "clean") return { ok: false as const, reason: "not_scanned" as const, scanStatus: doc.scanStatus };
  return { ok: true as const, doc };
}

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, lte } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser } from "./helpers";
import { FixtureExtractor, fixtureResult } from "./fixtures/fixture-extractor";

setupTestEnv();
process.env.MAX_UPLOAD_BYTES = String(64 * 1024);
const { resetEnvCache } = await import("../src/env");
resetEnvCache();
const { withSystem, withTenant } = await import("../src/db/tenant");
const schema = await import("../src/db/schema");
const { auditEvents, documents, exceptions, invoiceLines, invoices, jobs, memberships } = schema;
const q = await import("../src/lib/jobs/queue");
const { getHandler, JOB_TYPES } = await import("../src/lib/jobs/registry");
const { setDocumentDepsForTests } = await import("../src/modules/documents/deps");
const svc = await import("../src/modules/documents/service");
const { correctInvoice, RevisionConflictError } = await import("../src/modules/documents/correction");
const { getPreviewableDocument, getInvoiceDetail, listInvoices } = await import("../src/modules/documents/queries");
const { SCAN_NOT_CONFIGURED } = await import("../src/modules/documents/jobs");
await import("../src/modules/extraction/jobs");
const { ExtractionTransientError } = await import("../src/modules/extraction/types");
type ScanResult = import("../src/lib/scan/clamav").ScanResult;
type Role = import("../src/lib/auth/permissions").Role;

// ───────────── test doubles (test-only; installed via setDocumentDepsForTests) ─────────────

const store = new Map<string, Buffer>();
const storage = {
  configured: () => true,
  put: async (k: string, b: Buffer) => void store.set(k, Buffer.from(b)),
  get: async (k: string) => {
    const b = store.get(k);
    if (!b) throw new Error("NoSuchKey");
    return b;
  },
  delete: async (k: string) => void store.delete(k),
};
let scanConfigured = true;
let nextScan: () => Promise<ScanResult> = async () => ({ status: "clean" });
const scanner = { configured: () => scanConfigured, scan: () => nextScan() };
const extractor = new FixtureExtractor(() => fixtureResult("invoice-confident"));

beforeEach(() => {
  scanConfigured = true;
  nextScan = async () => ({ status: "clean" });
  extractor.setNext(() => fixtureResult("invoice-confident"));
  setDocumentDepsForTests({ storage, scanner, extractor });
});

let seq = 0;
function pdf(extra = ""): Buffer {
  seq++;
  return Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n% unique ${seq} ${Math.random()} ${extra}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

async function member(orgId: string, role: Role) {
  const u = await makeUser(role);
  await withSystem((tx) => tx.insert(memberships).values({ orgId, userId: u.id, role }));
  return { userId: u.id, orgId, role };
}

/** Run every runnable job of this org through the real queue state machine, like the worker does. */
async function drain(orgId: string, max = 20) {
  const ran: { type: string; status: string; error?: string }[] = [];
  for (let i = 0; i < max; i++) {
    const job = await withSystem(async (tx) => {
      const [j] = await tx.select().from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.status, "queued"), lte(jobs.runAfter, new Date()))).orderBy(jobs.createdAt).limit(1);
      if (!j) return null;
      const [claimed] = await tx.update(jobs).set({ status: "running", attempts: j.attempts + 1, lockedBy: "test", lockedAt: new Date() }).where(eq(jobs.id, j.id)).returning();
      return claimed!;
    });
    if (!job) break;
    const handler = getHandler(job.type);
    if (!handler) {
      // Matching belongs to another module; leave its jobs queued.
      await withSystem((tx) => tx.update(jobs).set({ status: "cancelled", lockedBy: null }).where(eq(jobs.id, job.id)));
      ran.push({ type: job.type, status: "unhandled" });
      continue;
    }
    try {
      const result = await handler({ job, orgId, workerId: "test" });
      await q.completeJob(job, "test", result ?? null);
      ran.push({ type: job.type, status: "succeeded" });
    } catch (err) {
      await q.failJob(job, "test", err);
      ran.push({ type: job.type, status: "failed", error: (err as Error).message });
    }
  }
  return ran;
}

const getInvoice = (orgId: string, id: string) => withTenant(orgId, async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)))[0]!);
const getExceptions = (orgId: string, id: string) => withTenant(orgId, (tx) => tx.select().from(exceptions).where(eq(exceptions.invoiceId, id)));
const getJobs = (orgId: string, type: string) => withSystem((tx) => tx.select().from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.type, type))));

// ───────────── PDF validation ─────────────

describe("PDF validation", async () => {
  const { checkPdf, safeFileName } = await import("../src/modules/documents/pdf");
  const max = 1024 * 1024;
  it("accepts a well-formed PDF", () => expect(checkPdf(pdf(), max).ok).toBe(true));
  it("rejects non-PDF bytes by magic number", () => {
    const r = checkPdf(Buffer.from("MZ\x90\x00 this is an exe %%EOF"), max);
    expect(r.ok === false && r.rejection.code).toBe("not_pdf");
  });
  it("rejects empty, oversize and truncated files", () => {
    expect(checkPdf(Buffer.alloc(0), max)).toMatchObject({ ok: false, rejection: { code: "empty" } });
    expect(checkPdf(pdf("x".repeat(2000)), 1000)).toMatchObject({ ok: false, rejection: { code: "too_large" } });
    expect(checkPdf(Buffer.from("%PDF-1.7\n1 0 obj"), max)).toMatchObject({ ok: false, rejection: { code: "truncated" } });
  });
  it("rejects encrypted PDFs", () => {
    expect(checkPdf(pdf("trailer << /Encrypt 5 0 R >>"), max)).toMatchObject({ ok: false, rejection: { code: "encrypted" } });
  });
  it("rejects JavaScript and launch actions, including hex-escaped names", () => {
    expect(checkPdf(pdf("<< /S /JavaScript /JS (app.alert(1)) >>"), max)).toMatchObject({ ok: false, rejection: { code: "active_content" } });
    expect(checkPdf(pdf("<< /S /Java#53cript >>"), max)).toMatchObject({ ok: false, rejection: { code: "active_content" } });
    expect(checkPdf(pdf("<< /OpenAction << /JS (x) >> >>"), max)).toMatchObject({ ok: false, rejection: { code: "active_content" } });
    expect(checkPdf(pdf("<< /S /Launch /F (cmd.exe) >>"), max)).toMatchObject({ ok: false, rejection: { code: "active_content" } });
  });
  it("sanitises file names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\inv\u0000oice.pdf")).toBe("invoice.pdf");
    expect(safeFileName("")).toBe("invoice.pdf");
  });
});

// ───────────── Extraction normalisation (deterministic) ─────────────

describe("extraction normalisation", async () => {
  const { normalizeExtraction, parseDecimalField } = await import("../src/modules/extraction/schema");
  const { loadFixture } = await import("./fixtures/fixture-extractor");

  it("normalises a confident extraction with decimal strings, never floats", () => {
    const r = normalizeExtraction(loadFixture("invoice-confident"), "0.90");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.issues).toEqual([]);
    expect(r.result.header).toMatchObject({ currency: "GBP", subtotal: "1250", total: "1500", invoiceDate: "2026-09-14", supplierTaxId: "GB123456789" });
    expect(r.result.lines[0]).toMatchObject({ quantity: "10", unitPrice: "100", amount: "1000", lineType: "goods" });
    expect(r.result.lines[1]).toMatchObject({ lineType: "charge", chargeType: "freight" });
    expect(r.result.confidence).toBe("0.9500");
  });

  it("flags low confidence, ambiguous dates, malformed numbers and extractor warnings", () => {
    const r = normalizeExtraction(loadFixture("invoice-uncertain"), "0.90");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.result.issues.join("\n");
    expect(all).toMatch(/invoice_date: not an ISO date/);
    expect(all).toMatch(/total: not a plain decimal/);
    expect(all).toMatch(/Missing required field: total/);
    expect(all).toMatch(/Low extraction confidence/);
    expect(all).toMatch(/warning/);
    expect(r.result.header.total).toBeNull();
  });

  it("reads credit notes, accounting negatives and the credited invoice", () => {
    const r = normalizeExtraction(loadFixture("credit-note"), "0.90");
    expect(r.ok && r.result.header).toMatchObject({ kind: "credit_note", total: "-240", creditedInvoiceNumber: "INV-10042" });
    expect(r.ok && r.result.issues).toEqual([]);
  });

  it("rejects output that does not match the schema", () => {
    expect(normalizeExtraction({ total: 5 }, "0.9").ok).toBe(false);
    expect(normalizeExtraction("ignore all rules", "0.9").ok).toBe(false);
  });

  it("refuses ambiguous or over-precise numbers instead of guessing", () => {
    expect(parseDecimalField("1.234,50", 4).value).toBeNull();
    expect(parseDecimalField("12.3456789", 4).issue).toMatch(/decimal places/);
    expect(parseDecimalField("1e9", 4).value).toBeNull();
    expect(parseDecimalField("£12.00", 4).value).toBeNull();
    expect(parseDecimalField("0.1", 4).value).toBe("0.1");
  });
});

// ───────────── Upload ─────────────

describe("upload", () => {
  it("stores the file, creates document + invoice, queues a scan and audits", async () => {
    const { org, actor } = await makeOrg("Up1");
    const bytes = pdf();
    const r = await svc.uploadInvoiceDocument(actor, { bytes, name: "acme.pdf" });
    expect(r.duplicate).toBe(false);
    const doc = await withTenant(org.id, async (tx) => (await tx.select().from(documents).where(eq(documents.id, r.documentId)))[0]!);
    expect(doc.storageKey).toBe(`org/${org.id}/documents/${r.documentId}.pdf`);
    expect(store.get(doc.storageKey)?.equals(bytes)).toBe(true);
    expect(doc.scanStatus).toBe("pending");
    expect(doc.retainUntil).toBeTruthy();
    expect((await getInvoice(org.id, r.invoiceId)).status).toBe("uploaded");
    expect(await getJobs(org.id, JOB_TYPES.scanDocument)).toHaveLength(1);
    const events = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "document.uploaded")));
    expect(events).toHaveLength(1);
  });

  it("dedupes identical files per org and returns the existing invoice", async () => {
    const { org, actor } = await makeOrg("Up2");
    const bytes = pdf();
    const a = await svc.uploadInvoiceDocument(actor, { bytes, name: "a.pdf" });
    const b = await svc.uploadInvoiceDocument(actor, { bytes, name: "copy.pdf" });
    expect(b).toEqual({ ...a, duplicate: true });
    const dupAudit = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "document.duplicate_upload")));
    expect(dupAudit.map((e) => e.entityId)).toEqual([a.invoiceId]);
    // Concurrent duplicates: exactly one row, no orphaned objects.
    const c = pdf();
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.uploadInvoiceDocument(actor, { bytes: c, name: "c.pdf" })));
    expect(new Set(results.map((r) => r.invoiceId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const docs = await withTenant(org.id, (tx) => tx.select().from(documents));
    expect(docs).toHaveLength(2);
    expect([...store.keys()].filter((k) => k.startsWith(`org/${org.id}/`))).toHaveLength(2);
    // The same file in another org is a separate document.
    const other = await makeOrg("Up2b");
    expect((await svc.uploadInvoiceDocument(other.actor, { bytes, name: "a.pdf" })).duplicate).toBe(false);
  });

  it("rejects invalid PDFs, oversize files and viewers; reports missing storage", async () => {
    const { org, actor } = await makeOrg("Up3");
    await expect(svc.uploadInvoiceDocument(actor, { bytes: Buffer.from("hello"), name: "x.pdf" })).rejects.toMatchObject({ code: "pdf_not_pdf" });
    await expect(svc.uploadInvoiceDocument(actor, { bytes: pdf("/JavaScript"), name: "x.pdf" })).rejects.toMatchObject({ code: "pdf_active_content" });
    await expect(svc.uploadInvoiceDocument(actor, { bytes: pdf("x".repeat(70 * 1024)), name: "x.pdf" })).rejects.toMatchObject({ code: "pdf_too_large" });
    const viewer = await member(org.id, "viewer");
    await expect(svc.uploadInvoiceDocument(viewer, { bytes: pdf(), name: "x.pdf" })).rejects.toThrow(/invoice.upload/);
    const reviewer = await member(org.id, "reviewer");
    expect((await svc.uploadInvoiceDocument(reviewer, { bytes: pdf(), name: "x.pdf" })).duplicate).toBe(false);
    setDocumentDepsForTests({ storage: { ...storage, configured: () => false }, scanner, extractor });
    await expect(svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "x.pdf" })).rejects.toMatchObject({ code: "storage_not_configured" });
  });
});

// ───────────── Scan → extract pipeline ─────────────

describe("scan and extraction jobs", () => {
  it("clean scan → confident extraction → matching queued with the revision key", async () => {
    const { org, actor } = await makeOrg("P1");
    const { invoiceId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p1.pdf" });
    const ran = await drain(org.id);
    expect(ran.map((r) => `${r.type}:${r.status}`)).toEqual(["document.scan:succeeded", "invoice.extract:succeeded", "invoice.match:unhandled"]);
    const inv = await getInvoice(org.id, invoiceId);
    expect(inv).toMatchObject({ status: "matching", invoiceNumber: "INV-10042", currency: "GBP", total: "1500.0000", subtotal: "1250.0000", supplierTaxIdRaw: "GB123456789", extractionModel: "fixture-model", revision: 1 });
    const lines = await withTenant(org.id, (tx) => tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.lineNo));
    expect(lines.map((l) => [l.lineNo, l.quantity, l.unitPrice, l.amount])).toEqual([
      [1, "10.0000", "100.000000", "1000.0000"],
      [2, "1.0000", "250.000000", "250.0000"],
    ]);
    const match = await getJobs(org.id, JOB_TYPES.matchInvoice);
    expect(match.map((j) => j.idempotencyKey)).toEqual([`${org.id}:invoice.match:${invoiceId}:1`]);
    expect(await getExceptions(org.id, invoiceId)).toHaveLength(0);
  });

  it("re-running scan and extract jobs (at-least-once delivery) creates nothing twice", async () => {
    const { org, actor } = await makeOrg("P2");
    const { invoiceId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p2.pdf" });
    await drain(org.id);
    const scanJob = (await getJobs(org.id, JOB_TYPES.scanDocument))[0]!;
    const extractJob = (await getJobs(org.id, JOB_TYPES.extractInvoice))[0]!;
    const calls = extractor.calls;
    await getHandler(JOB_TYPES.scanDocument)!({ job: scanJob, orgId: org.id, workerId: "w" });
    await getHandler(JOB_TYPES.extractInvoice)!({ job: extractJob, orgId: org.id, workerId: "w" });
    expect(extractor.calls).toBe(calls); // no second model call once past extraction
    expect(await getJobs(org.id, JOB_TYPES.extractInvoice)).toHaveLength(1);
    expect(await getJobs(org.id, JOB_TYPES.matchInvoice)).toHaveLength(1);
    expect(await withTenant(org.id, (tx) => tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)))).toHaveLength(2);
  });

  it("uncertain extraction goes to review with one exception, never to matching", async () => {
    const { org, actor } = await makeOrg("P3");
    extractor.setNext(() => fixtureResult("invoice-uncertain"));
    const { invoiceId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p3.pdf" });
    await drain(org.id);
    const inv = await getInvoice(org.id, invoiceId);
    expect(inv.status).toBe("extraction_review");
    expect(inv.total).toBeNull();
    expect((inv.extractionRaw as { issues: string[] }).issues.length).toBeGreaterThan(2);
    const exc = await getExceptions(org.id, invoiceId);
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ kind: "extraction_review", status: "open" });
    expect(await getJobs(org.id, JOB_TYPES.matchInvoice)).toHaveLength(0);
  });

  it("model refusals, truncation and schema-invalid output are routed to review", async () => {
    for (const next of [
      () => ({ kind: "incomplete" as const, model: "m", reason: "The extraction model declined to process this document." }),
      () => ({ kind: "ok" as const, model: "m", output: { totally: "wrong" } }),
    ]) {
      const { org, actor } = await makeOrg("P4");
      extractor.setNext(next);
      const { invoiceId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p4.pdf" });
      await drain(org.id);
      expect((await getInvoice(org.id, invoiceId)).status).toBe("extraction_review");
      expect(await getExceptions(org.id, invoiceId)).toHaveLength(1);
    }
  });

  it("infected files are quarantined with a processing exception and never extracted or served", async () => {
    const { org, actor } = await makeOrg("P5");
    nextScan = async () => ({ status: "infected", signature: "Eicar-Test-Signature" });
    const calls = extractor.calls;
    const { invoiceId, documentId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "bad.pdf" });
    await drain(org.id);
    expect((await getInvoice(org.id, invoiceId)).status).toBe("quarantined");
    expect(extractor.calls).toBe(calls);
    const exc = await getExceptions(org.id, invoiceId);
    expect(exc.map((e) => e.kind)).toEqual(["processing_failure"]);
    expect(await getPreviewableDocument(org.id, documentId)).toMatchObject({ ok: false, reason: "not_scanned" });
    await expect(svc.retryInvoiceProcessing(actor, invoiceId)).rejects.toMatchObject({ code: "quarantined" });
  });

  it("missing ClamAV keeps the invoice in scanning with a visible reason; never treated as clean", async () => {
    const { org, actor } = await makeOrg("P6");
    scanConfigured = false;
    const { invoiceId, documentId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p6.pdf" });
    const ran = await drain(org.id);
    expect(ran).toEqual([{ type: "document.scan", status: "failed", error: SCAN_NOT_CONFIGURED }]);
    const inv = await getInvoice(org.id, invoiceId);
    expect(inv.status).toBe("scanning");
    expect(inv.failureReason).toMatch(/not configured/);
    expect(await getPreviewableDocument(org.id, documentId)).toMatchObject({ ok: false });
    expect(await getJobs(org.id, JOB_TYPES.extractInvoice)).toHaveLength(0);
    // Once configured, an admin retry completes the pipeline.
    scanConfigured = true;
    await svc.retryInvoiceProcessing(actor, invoiceId);
    await drain(org.id);
    expect((await getInvoice(org.id, invoiceId)).status).toBe("matching");
    expect(await getPreviewableDocument(org.id, documentId)).toMatchObject({ ok: true });
  });

  it("missing AI extraction leaves a visible setup state and does not fake a result", async () => {
    const { org, actor } = await makeOrg("P7");
    const unconfigured = Object.assign(new FixtureExtractor(() => fixtureResult("invoice-confident")), { configured: () => false, missing: () => ["ANTHROPIC_API_KEY"] });
    setDocumentDepsForTests({ storage, scanner, extractor: unconfigured });
    const { invoiceId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p7.pdf" });
    await drain(org.id);
    const inv = await getInvoice(org.id, invoiceId);
    expect(inv.status).toBe("extracting");
    expect(inv.failureReason).toMatch(/ANTHROPIC_API_KEY/);
    expect(inv.invoiceNumber).toBeNull();
    expect(unconfigured.calls).toBe(0);
  });

  it("transient provider errors retry with backoff, then fail visibly with a processing exception", async () => {
    const { org, actor } = await makeOrg("P8");
    extractor.setNext(() => {
      throw new ExtractionTransientError("429 rate limited");
    });
    const { invoiceId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p8.pdf" });
    await drain(org.id);
    let job = (await getJobs(org.id, JOB_TYPES.extractInvoice))[0]!;
    expect(job.status).toBe("queued");
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect((await getInvoice(org.id, invoiceId)).status).toBe("extracting");
    for (let i = 0; i < 6; i++) {
      await withSystem((tx) => tx.update(jobs).set({ runAfter: new Date(0) }).where(eq(jobs.id, job.id)));
      await drain(org.id);
    }
    job = (await getJobs(org.id, JOB_TYPES.extractInvoice))[0]!;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(job.maxAttempts);
    const inv = await getInvoice(org.id, invoiceId);
    expect(inv.status).toBe("failed");
    expect(inv.failureReason).toMatch(/rate limited/);
    expect((await getExceptions(org.id, invoiceId)).filter((e) => e.kind === "processing_failure")).toHaveLength(1);

    // Manual recovery: reviewers cannot, admins can; the invoice returns to extraction.
    const reviewer = await member(org.id, "reviewer");
    await expect(svc.retryInvoiceProcessing(reviewer, invoiceId)).rejects.toThrow(/jobs.recover/);
    extractor.setNext(() => fixtureResult("invoice-confident"));
    await svc.retryInvoiceProcessing(actor, invoiceId);
    await drain(org.id);
    expect((await getInvoice(org.id, invoiceId)).status).toBe("matching");
    expect((await getExceptions(org.id, invoiceId)).every((e) => e.status === "dismissed")).toBe(true);
  });

  it("a stored object that no longer matches its hash is not scanned or extracted", async () => {
    const { org, actor } = await makeOrg("P9");
    const { invoiceId, documentId } = await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "p9.pdf" });
    store.set(`org/${org.id}/documents/${documentId}.pdf`, pdf("tampered"));
    await drain(org.id);
    expect((await getInvoice(org.id, invoiceId)).status).toBe("failed");
  });
});

// ───────────── Manual correction ─────────────

async function extractedInvoice(name: string, fixture = "invoice-uncertain") {
  const o = await makeOrg(name);
  extractor.setNext(() => fixtureResult(fixture));
  const { invoiceId } = await svc.uploadInvoiceDocument(o.actor, { bytes: pdf(), name: `${name}.pdf` });
  await drain(o.org.id);
  const detail = (await getInvoiceDetail(o.org.id, invoiceId))!;
  return { ...o, invoiceId, detail };
}

function correctionFrom(detail: NonNullable<Awaited<ReturnType<typeof getInvoiceDetail>>>) {
  const i = detail.invoice;
  return {
    header: {
      kind: i.kind,
      supplierNameRaw: i.supplierNameRaw,
      supplierTaxIdRaw: i.supplierTaxIdRaw,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      currency: i.currency,
      poNumberRaw: i.poNumberRaw,
      creditsInvoiceNumberRaw: i.creditsInvoiceNumberRaw,
      subtotal: i.subtotal,
      taxTotal: i.taxTotal,
      total: i.total,
    },
    lines: detail.lines.map((l) => ({ id: l.id, lineType: l.lineType, chargeType: l.chargeType, sku: l.sku, description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, amount: l.amount, taxRate: l.taxRate, poLineRef: l.poLineRef })),
  };
}

describe("manual correction", () => {
  it("corrects header and lines, bumps the revision, re-queues matching, resolves the review and audits", async () => {
    const { org, actor, invoiceId, detail } = await extractedInvoice("C1");
    const input = correctionFrom(detail);
    input.header.invoiceDate = "2026-04-03";
    input.header.total = "1440.00";
    input.header.subtotal = "1200";
    input.header.taxTotal = "240";
    input.lines[0]!.taxRate = "20";
    input.lines.push({ id: null as unknown as string, lineType: "charge", chargeType: "freight", sku: null, description: "Delivery", quantity: "1", unit: "each", unitPrice: "0", amount: "0", taxRate: "20", poLineRef: null });
    const res = await correctInvoice(actor, invoiceId, 1, input);
    expect(res).toEqual({ revision: 2, changed: true, confirmed: false, missing: [] });
    const inv = await getInvoice(org.id, invoiceId);
    expect(inv).toMatchObject({ status: "matching", revision: 2, invoiceDate: "2026-04-03", total: "1440.0000" });
    const lines = await withTenant(org.id, (tx) => tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.lineNo));
    expect(lines.map((l) => [l.lineNo, l.manuallyCorrected, l.taxRate])).toEqual([[1, true, "20.0000"], [2, true, "20.0000"]]);
    expect((await getJobs(org.id, JOB_TYPES.matchInvoice)).map((j) => j.idempotencyKey)).toEqual([`${org.id}:invoice.match:${invoiceId}:2`]);
    expect((await getExceptions(org.id, invoiceId)).map((e) => e.status)).toEqual(["dismissed"]);
    const actions = (await withTenant(org.id, (tx) => tx.select().from(auditEvents))).map((e) => e.action);
    expect(actions.filter((a) => a === "invoice.line_corrected")).toHaveLength(2);
    expect(actions).toContain("invoice.header_corrected");
    expect(actions).toContain("exception.decided");
  });

  it("rejects stale revisions so concurrent edits are not lost", async () => {
    const { actor, invoiceId, detail } = await extractedInvoice("C2");
    const a = correctionFrom(detail);
    a.header.invoiceDate = "2026-04-03";
    const b = correctionFrom(detail);
    b.header.invoiceDate = "2026-03-04";
    const results = await Promise.allSettled([correctInvoice(actor, invoiceId, 1, a), correctInvoice(actor, invoiceId, 1, b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RevisionConflictError);
  });

  it("validates corrected values with the same decimal rules and refuses viewers", async () => {
    const { org, actor, invoiceId, detail } = await extractedInvoice("C3");
    const bad = correctionFrom(detail);
    bad.header.total = "12,5";
    await expect(correctInvoice(actor, invoiceId, 1, bad)).rejects.toMatchObject({ code: "invalid_correction" });
    const viewer = await member(org.id, "viewer");
    await expect(correctInvoice(viewer, invoiceId, 1, correctionFrom(detail))).rejects.toThrow(/invoice.edit/);
    // Unchanged save on an invoice in review is a confirmation, refused while required values are missing.
    await expect(correctInvoice(actor, invoiceId, 1, correctionFrom(detail))).rejects.toMatchObject({ code: "missing_required" });
  });

  it("confirms a flagged but correct extraction without edits and sends it to matching", async () => {
    const { org, actor, invoiceId } = await extractedInvoice("C5", "invoice-confident");
    // Simulate a confident extraction that a rule still flagged (e.g. an extractor warning).
    await withTenant(org.id, (tx) => tx.update(invoices).set({ status: "extraction_review" }).where(eq(invoices.id, invoiceId)));
    await withSystem((tx) => tx.delete(jobs).where(and(eq(jobs.orgId, org.id), eq(jobs.type, JOB_TYPES.matchInvoice))));
    await withTenant(org.id, (tx) => tx.insert(exceptions).values({ orgId: org.id, invoiceId, kind: "extraction_review", title: "Check extracted values" }));
    const detail = (await getInvoiceDetail(org.id, invoiceId))!;
    const res = await correctInvoice(actor, invoiceId, 1, correctionFrom(detail));
    expect(res).toEqual({ revision: 2, changed: false, confirmed: true, missing: [] });
    expect((await getInvoice(org.id, invoiceId)).status).toBe("matching");
    expect((await getExceptions(org.id, invoiceId)).map((e) => [e.status, e.decisionReason])).toEqual([["dismissed", "Extracted values confirmed by reviewer (revision 2)"]]);
    expect((await getJobs(org.id, JOB_TYPES.matchInvoice)).map((j) => j.idempotencyKey)).toEqual([`${org.id}:invoice.match:${invoiceId}:2`]);
    const actions = (await withTenant(org.id, (tx) => tx.select().from(auditEvents))).map((e) => e.action);
    expect(actions).toContain("invoice.extraction_confirmed");
    // Saving again on a matched invoice with no changes is a no-op.
    expect(await correctInvoice(actor, invoiceId, 2, correctionFrom((await getInvoiceDetail(org.id, invoiceId))!))).toMatchObject({ revision: 2, changed: false, confirmed: false });
  });

  it("keeps a partially corrected invoice in review until required values are present", async () => {
    const { org, actor, invoiceId, detail } = await extractedInvoice("C6");
    const input = correctionFrom(detail);
    input.header.invoiceDate = "2026-04-03";
    const res = await correctInvoice(actor, invoiceId, 1, input);
    expect(res).toMatchObject({ revision: 2, changed: true, missing: ["total"] });
    expect((await getInvoice(org.id, invoiceId)).status).toBe("extraction_review");
    expect(await getJobs(org.id, JOB_TYPES.matchInvoice)).toHaveLength(0);
    expect((await getExceptions(org.id, invoiceId)).map((e) => e.status)).toEqual(["open"]);
    input.header.total = "1200";
    expect(await correctInvoice(actor, invoiceId, 2, input)).toMatchObject({ revision: 3, missing: [] });
    expect((await getInvoice(org.id, invoiceId)).status).toBe("matching");
  });

  it("is tenant-isolated: another org cannot read, correct or preview the invoice", async () => {
    const { invoiceId, detail } = await extractedInvoice("C4");
    const other = await makeOrg("C4-other");
    expect(await getInvoiceDetail(other.org.id, invoiceId)).toBeNull();
    expect((await listInvoices(other.org.id, { page: 1 })).total).toBe(0);
    await expect(correctInvoice(other.actor, invoiceId, 1, correctionFrom(detail))).rejects.toMatchObject({ code: "not_found" });
    expect(await getPreviewableDocument(other.org.id, detail.doc.id)).toMatchObject({ ok: false, reason: "not_found" });
    await expect(svc.retryInvoiceProcessing(other.actor, invoiceId)).rejects.toMatchObject({ code: "not_found" });
    // A job carrying another tenant's ids finds nothing under RLS.
    const scanJob = (await withSystem((tx) => tx.select().from(jobs).where(and(eq(jobs.type, JOB_TYPES.scanDocument), eq(jobs.orgId, detail.invoice.orgId)))))[0]!;
    await expect(getHandler(JOB_TYPES.scanDocument)!({ job: scanJob, orgId: other.org.id, workerId: "w" })).rejects.toThrow(/not found/);
  });
});

describe("invoice list", () => {
  it("searches, filters by status group and paginates within the org", async () => {
    const { org, actor } = await makeOrg("L1");
    extractor.setNext(() => fixtureResult("invoice-confident"));
    await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "first.pdf" });
    await drain(org.id);
    extractor.setNext(() => fixtureResult("invoice-uncertain"));
    await svc.uploadInvoiceDocument(actor, { bytes: pdf(), name: "second.pdf" });
    await drain(org.id);
    expect((await listInvoices(org.id, { page: 1 })).total).toBe(2);
    expect((await listInvoices(org.id, { page: 1, q: "INV-10042" })).rows.map((r) => r.invoiceNumber)).toEqual(["INV-10042"]);
    expect((await listInvoices(org.id, { page: 1, q: "second" })).total).toBe(1);
    expect((await listInvoices(org.id, { page: 1, filter: "review" })).rows.map((r) => r.status)).toEqual(["extraction_review"]);
    expect((await listInvoices(org.id, { page: 1, q: "100%_" })).total).toBe(0);
    expect((await listInvoices(org.id, { page: 2 })).rows).toHaveLength(0);
  });
});

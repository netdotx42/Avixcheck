import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, lte } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser } from "../helpers";
import { FixtureExtractor, fixtureResult } from "../fixtures/fixture-extractor";

/**
 * Cross-module workflow: CSV import → PDF upload → malware scan → extraction →
 * matching → checks → exception review → decision → CSV export, all through the
 * real module services and job handlers on a real Postgres with RLS.
 *
 * Only the external services are replaced, and only in this test process:
 * object storage (in-memory map), ClamAV (returns "clean") and the AI extractor
 * (FixtureExtractor replaying recorded JSON). The S3_* variables below are dummy
 * values so `requireIntegration("storage")` passes; no request ever reaches S3
 * because every storage call goes through the injected test storage.
 */
setupTestEnv();
Object.assign(process.env, { S3_BUCKET: "qa-test", S3_REGION: "test", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test" });
const { resetEnvCache } = await import("../../src/env");
resetEnvCache();

const { withSystem, withTenant } = await import("../../src/db/tenant");
const { auditEvents, checkRuns, discrepancies, exceptions, exportsTable, invoices, jobs, memberships, poLineBillings } = await import("../../src/db/schema");
const q = await import("../../src/lib/jobs/queue");
const { getHandler, JOB_TYPES } = await import("../../src/lib/jobs/registry");
await import("../../src/worker/handlers");
const { setDocumentDepsForTests } = await import("../../src/modules/documents/deps");
const documentsSvc = await import("../../src/modules/documents/service");
const imports = await import("../../src/modules/imports/service");
const exceptionsSvc = await import("../../src/modules/exceptions/service");
const exportsSvc = await import("../../src/modules/exports/service");

type Role = "admin" | "reviewer" | "viewer";
type Actor = { userId: string; orgId: string; role: Role };

// ───────────── test-only doubles for external services ─────────────
const objects = new Map<string, Buffer>();
const storage = {
  configured: () => true,
  put: async (k: string, b: Buffer) => void objects.set(k, Buffer.from(b)),
  get: async (k: string) => {
    const b = objects.get(k);
    if (!b) throw new Error("NoSuchKey");
    return b;
  },
  delete: async (k: string) => void objects.delete(k),
};
const exportStorage = {
  put: async (k: string, b: Buffer) => void objects.set(k, Buffer.from(b)),
  signedUrl: async (_org: string, k: string) => `memory://${k}`,
};
const scanner = { configured: () => true, scan: async () => ({ status: "clean" as const }) };
const extractor = new FixtureExtractor(() => fixtureResult("invoice-confident"));

beforeEach(() => {
  extractor.setNext(() => fixtureResult("invoice-confident"));
  setDocumentDepsForTests({ storage, scanner, extractor });
});

let seq = 0;
function pdf(): Buffer {
  seq++;
  return Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n% qa ${seq} ${Math.random()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

async function member(orgId: string, role: Role): Promise<Actor> {
  const u = await makeUser(role);
  await withSystem((tx) => tx.insert(memberships).values({ orgId, userId: u.id, role }));
  return { userId: u.id, orgId, role };
}

/** Run this org's queued jobs through the real queue state machine, the way the worker does. */
async function drain(orgId: string, max = 30) {
  const ran: { type: string; status: string; error?: string }[] = [];
  for (let i = 0; i < max; i++) {
    const job = await withSystem(async (tx) => {
      const [j] = await tx.select().from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.status, "queued"), lte(jobs.runAfter, new Date()))).orderBy(jobs.createdAt).limit(1);
      if (!j) return null;
      const [claimed] = await tx.update(jobs).set({ status: "running", attempts: j.attempts + 1, lockedBy: "qa", lockedAt: new Date() }).where(eq(jobs.id, j.id)).returning();
      return claimed!;
    });
    if (!job) break;
    const run =
      job.type === JOB_TYPES.generateExport
        ? (ctx: Parameters<typeof exportsSvc.generateExport>[0]) => exportsSvc.generateExport(ctx, exportStorage)
        : getHandler(job.type);
    if (!run) throw new Error(`no handler registered for ${job.type}`);
    try {
      const result = await run({ job, orgId, workerId: "qa" });
      await q.completeJob(job, "qa", result ?? null);
      ran.push({ type: job.type, status: "succeeded" });
    } catch (err) {
      await q.failJob(job, "qa", err);
      ran.push({ type: job.type, status: "failed", error: (err as Error).message });
    }
  }
  return ran;
}

async function importCsv(actor: Actor, kind: "suppliers" | "purchase_orders" | "price_agreements" | "approved_charges", csv: string) {
  const preview = await imports.previewImport(actor, { kind, fileName: `${kind}.csv`, bytes: Buffer.from(csv) });
  expect(preview.errorCount, `${kind} preview errors`).toBe(0);
  const res = await imports.commitImport(actor, preview.batchId);
  expect(res.status, `${kind} commit`).toBe("committed");
  return preview.batchId;
}

const getInvoice = (orgId: string, id: string) => withTenant(orgId, async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)))[0]!);
const openExceptions = (orgId: string, invoiceId: string) => withTenant(orgId, (tx) => tx.select().from(exceptions).where(eq(exceptions.invoiceId, invoiceId)));
const discrepanciesOf = (orgId: string, invoiceId: string) => withTenant(orgId, (tx) => tx.select().from(discrepancies).where(eq(discrepancies.invoiceId, invoiceId)));

/** Reference data matching tests/fixtures/extraction/invoice-confident.json (Acme, PO-7781, BOLT-M8). */
async function seedReference(admin: Actor) {
  await importCsv(admin, "suppliers", "supplier_code,name,tax_id,currency,aliases\nACME,Acme Industrial Supplies Ltd,GB123456789,GBP,Acme Industrial\n");
  await importCsv(
    admin,
    "purchase_orders",
    "po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price\nPO-7781,ACME,GBP,2026-09-01,1,BOLT-M8,M8 hex bolts box of 100,20,box,90.000000\n",
  );
  await importCsv(
    admin,
    "price_agreements",
    "agreement_ref,supplier_code,sku,description,unit_price,currency,unit,discount_pct,min_quantity,valid_from,valid_to\nAGR-1,ACME,BOLT-M8,M8 hex bolts,90.000000,GBP,box,,,2026-01-01,2026-12-31\n",
  );
  await importCsv(admin, "approved_charges", "supplier_code,charge_type,max_amount,currency,valid_from,valid_to\nACME,freight,45.00,GBP,2026-01-01,\n");
}

describe("upload → extraction → matching → review → export", () => {
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let admin: Actor;
  let reviewer: Actor;
  let viewer: Actor;
  let invoiceId: string;

  beforeAll(async () => {
    org = await makeOrg("Workflow Co");
    admin = org.actor;
    reviewer = await member(org.org.id, "reviewer");
    viewer = await member(org.org.id, "viewer");
    await seedReference(admin);
  });

  it("viewers cannot upload", async () => {
    await expect(documentsSvc.uploadInvoiceDocument(viewer, { bytes: pdf(), name: "x.pdf" })).rejects.toThrow(/invoice.upload/);
  });

  it("an uploaded invoice is scanned, extracted, matched and checked by background jobs", async () => {
    const up = await documentsSvc.uploadInvoiceDocument(reviewer, { bytes: pdf(), name: "INV-10042.pdf" });
    expect(up.duplicate).toBe(false);
    invoiceId = up.invoiceId;
    const ran = await drain(org.org.id);
    expect(ran.filter((r) => r.status !== "succeeded"), JSON.stringify(ran)).toEqual([]);
    expect(ran.map((r) => r.type)).toEqual(expect.arrayContaining([JOB_TYPES.scanDocument, JOB_TYPES.extractInvoice, JOB_TYPES.matchInvoice, JOB_TYPES.checkInvoice]));

    const inv = await getInvoice(org.org.id, invoiceId);
    expect(inv.invoiceNumber).toBe("INV-10042");
    expect(inv.supplierId).not.toBeNull();
    expect(inv.purchaseOrderId).not.toBeNull();
    expect(inv.status).toBe("exceptions_open");
  });

  it("flags the price variance and the unapproved freight with exact decimal amounts", async () => {
    const ds = await discrepanciesOf(org.org.id, invoiceId);
    const byType = Object.fromEntries(ds.map((d) => [d.type, d]));
    // 10 boxes at 100.00 invoiced vs 90.00 agreed → 100.00 over.
    expect(byType.price_variance, JSON.stringify(ds.map((d) => d.type))).toBeDefined();
    expect(byType.price_variance!.amount).toMatch(/^100(\.0+)?$/);
    // Freight 250.00 against an approved maximum of 45.00 → 205.00 over.
    expect(byType.unapproved_charge).toBeDefined();
    expect(byType.unapproved_charge!.amount).toMatch(/^205(\.0+)?$/);
    expect(ds.find((d) => d.type === "arithmetic_error")).toBeUndefined();
    const ex = await openExceptions(org.org.id, invoiceId);
    expect(ex.filter((e) => e.kind === "discrepancy")).toHaveLength(ds.length);
  });

  it("re-running the same check is idempotent: no duplicate discrepancies or billings", async () => {
    const inv = await getInvoice(org.org.id, invoiceId);
    const before = { d: (await discrepanciesOf(org.org.id, invoiceId)).length, e: (await openExceptions(org.org.id, invoiceId)).length };
    const handler = getHandler(JOB_TYPES.checkInvoice)!;
    const fakeJob = { id: crypto.randomUUID(), orgId: org.org.id, type: JOB_TYPES.checkInvoice, payload: { invoiceId, revision: inv.revision }, attempts: 1, maxAttempts: 5 } as never;
    await handler({ job: fakeJob, orgId: org.org.id, workerId: "qa" });
    await handler({ job: fakeJob, orgId: org.org.id, workerId: "qa" });
    expect((await discrepanciesOf(org.org.id, invoiceId)).length).toBe(before.d);
    expect((await openExceptions(org.org.id, invoiceId)).length).toBe(before.e);
    const active = await withTenant(org.org.id, (tx) => tx.select().from(poLineBillings).where(and(eq(poLineBillings.invoiceId, invoiceId), eq(poLineBillings.active, true))));
    expect(active.length).toBeLessThanOrEqual(1);
    const runs = await withTenant(org.org.id, (tx) => tx.select().from(checkRuns).where(eq(checkRuns.invoiceId, invoiceId)));
    expect(runs.filter((r) => r.status === "completed")).toHaveLength(1);
  });

  it("uploading the same PDF again returns the existing invoice", async () => {
    const bytes = pdf();
    const a = await documentsSvc.uploadInvoiceDocument(reviewer, { bytes, name: "a.pdf" });
    const b = await documentsSvc.uploadInvoiceDocument(reviewer, { bytes, name: "b.pdf" });
    expect(b.duplicate).toBe(true);
    expect(b.invoiceId).toBe(a.invoiceId);
    await drain(org.org.id);
  });

  it("enforces roles when deciding: viewer blocked, reviewer requests correction, only admin accepts variance", async () => {
    const ex = (await openExceptions(org.org.id, invoiceId)).filter((e) => e.kind === "discrepancy" && e.status === "open");
    const ds = await discrepanciesOf(org.org.id, invoiceId);
    const price = ex.find((e) => ds.find((d) => d.id === e.discrepancyId)?.type === "price_variance")!;
    const freight = ex.find((e) => ds.find((d) => d.id === e.discrepancyId)?.type === "unapproved_charge")!;

    await expect(exceptionsSvc.decideException(viewer, { exceptionId: price.id, revision: price.revision, decision: "request_correction", reason: "x" })).rejects.toThrow(/exception.decide/);
    await exceptionsSvc.assignException(admin, { exceptionId: price.id, revision: price.revision, assigneeUserId: reviewer.userId });
    const assigned = (await openExceptions(org.org.id, invoiceId)).find((e) => e.id === price.id)!;
    await exceptionsSvc.decideException(reviewer, { exceptionId: price.id, revision: assigned.revision, decision: "request_correction", reason: "Agreement price is 90.00" });

    await expect(
      exceptionsSvc.decideException(reviewer, { exceptionId: freight.id, revision: freight.revision, decision: "accept_variance", reason: "one-off", confirmAboveTolerance: true }),
    ).rejects.toThrow(/accept_variance|Missing permission/);
    await expect(exceptionsSvc.decideException(admin, { exceptionId: freight.id, revision: freight.revision, decision: "accept_variance", reason: "one-off" })).rejects.toThrow(/Confirm/);
    await exceptionsSvc.decideException(admin, { exceptionId: freight.id, revision: freight.revision, decision: "accept_variance", reason: "Urgent delivery agreed by phone", confirmAboveTolerance: true });

    // A stale revision is refused rather than overwriting the decision.
    await expect(exceptionsSvc.decideException(admin, { exceptionId: freight.id, revision: freight.revision, decision: "dismiss", reason: "late" })).rejects.toThrow();

    const audit = await withTenant(org.org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "exception.decided")));
    expect(audit.filter((a) => [price.id, freight.id].includes(a.entityId ?? ""))).toHaveLength(2);
  });

  it("exports discrepancies with decisions, scoped to this org and CSV-injection safe", async () => {
    const other = await makeOrg("Other Co");
    const { id } = await exportsSvc.requestExport(reviewer, { kind: "discrepancies", filters: {} });
    await expect(exportsSvc.requestExport(viewer, { kind: "discrepancies", filters: {} })).rejects.toThrow(/export.create/);
    const ran = await drain(org.org.id);
    expect(ran.find((r) => r.type === JOB_TYPES.generateExport)?.status).toBe("succeeded");
    const [exp] = await withTenant(org.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)));
    expect(exp?.status).toBe("ready");
    expect(exp!.storageKey!.startsWith(`org/${org.org.id}/exports/`)).toBe(true);
    const csv = objects.get(exp!.storageKey!)!.toString("utf8");
    expect(csv).toContain("INV-10042");
    expect(csv).toMatch(/price_variance|Price/i);
    expect(csv).not.toMatch(/^[=+\-@]/m);
    // Another org can neither see the export row nor get a download URL for it.
    expect(await withTenant(other.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)))).toHaveLength(0);
    await expect(exportsSvc.exportDownloadUrl(other.actor, id, exportStorage)).rejects.toThrow();
  });

  it("uncertain extraction is routed to review and never checked as passed", async () => {
    extractor.setNext(() => fixtureResult("invoice-uncertain"));
    const up = await documentsSvc.uploadInvoiceDocument(reviewer, { bytes: pdf(), name: "blurry.pdf" });
    await drain(org.org.id);
    const inv = await getInvoice(org.org.id, up.invoiceId);
    expect(inv.status).toBe("extraction_review");
    const ex = await openExceptions(org.org.id, up.invoiceId);
    expect(ex.some((e) => e.kind === "extraction_review" && e.status === "open")).toBe(true);
    const runs = await withTenant(org.org.id, (tx) => tx.select().from(checkRuns).where(eq(checkRuns.invoiceId, up.invoiceId)));
    expect(runs).toHaveLength(0);
  });
});

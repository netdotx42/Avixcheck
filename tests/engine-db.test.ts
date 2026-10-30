import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeOrg, makeUser, setupTestEnv } from "./helpers";

setupTestEnv();
const { withTenant, withSystem } = await import("../src/db/tenant");
const s = await import("../src/db/schema");
const { enqueueMatch, runMatching, requestRecheck, confirmMatch } = await import("../src/modules/matching/service");
const { runCheck } = await import("../src/modules/checks/service");
const { poBalances, releaseInvoiceBillings } = await import("../src/modules/checks/balances");
const { runOnce } = await import("../src/lib/jobs/runner");
const { decideException } = await import("../src/modules/exceptions/service");
await import("../src/worker/handlers");

type Org = Awaited<ReturnType<typeof makeOrg>>;

interface Ref {
  supplierId: string;
  poId: string;
  poLineId: string;
}

/** Supplier ACME, PO-1001 with one line: 100 × SKU1 @ 10.00, plus a dated agreement at 10.00. */
async function seedReference(org: Org, o: { qty?: string } = {}): Promise<Ref> {
  return withTenant(org.org.id, async (tx) => {
    const [sup] = await tx.insert(s.suppliers).values({ orgId: org.org.id, code: "ACME", name: "Acme Supplies Ltd", taxId: "GB111", currency: "GBP" }).returning();
    const [po] = await tx.insert(s.purchaseOrders).values({ orgId: org.org.id, supplierId: sup!.id, poNumber: "PO-1001", currency: "GBP" }).returning();
    const [line] = await tx
      .insert(s.poLines)
      .values({ orgId: org.org.id, poId: po!.id, lineNo: 1, sku: "SKU1", description: "Widget", quantity: o.qty ?? "100", unit: "each", unitPrice: "10.00" })
      .returning();
    await tx.insert(s.priceAgreements).values({ orgId: org.org.id, supplierId: sup!.id, agreementRef: "AG-1", sku: "SKU1", unitPrice: "10.00", currency: "GBP", unit: "each", validFrom: "2026-01-01" });
    return { supplierId: sup!.id, poId: po!.id, poLineId: line!.id };
  });
}

interface InvoiceSpec {
  number?: string;
  kind?: "invoice" | "credit_note";
  qty?: string;
  price?: string;
  supplierName?: string;
  poNumber?: string | null;
  description?: string | null;
  sku?: string | null;
  total?: string;
}

/** Creates an extracted invoice and hands it to the matcher exactly like the documents module does. */
async function createInvoice(org: Org, spec: InvoiceSpec = {}) {
  const qty = spec.qty ?? "10";
  const price = spec.price ?? "10.00";
  const sign = spec.kind === "credit_note" ? "-" : "";
  const amount = (Number(qty) * Number(price)).toFixed(2); // test fixture only; the engine uses decimals
  return withTenant(org.org.id, async (tx) => {
    const [doc] = await tx
      .insert(s.documents)
      .values({ orgId: org.org.id, storageKey: `org/${org.org.id}/documents/${randomUUID()}.pdf`, sha256: randomUUID(), sizeBytes: 1000, mimeType: "application/pdf", originalName: "inv.pdf", scanStatus: "clean" })
      .returning();
    const [inv] = await tx
      .insert(s.invoices)
      .values({
        orgId: org.org.id,
        documentId: doc!.id,
        status: "extracting",
        kind: spec.kind ?? "invoice",
        supplierNameRaw: spec.supplierName ?? "ACME Supplies Limited",
        invoiceNumber: spec.number ?? `INV-${randomUUID().slice(0, 6)}`,
        invoiceDate: "2026-03-01",
        currency: "GBP",
        poNumberRaw: spec.poNumber === undefined ? "PO-1001" : spec.poNumber,
        subtotal: `${sign}${amount}`,
        taxTotal: "0",
        total: spec.total ?? `${sign}${amount}`,
      })
      .returning();
    await tx.insert(s.invoiceLines).values({
      orgId: org.org.id,
      invoiceId: inv!.id,
      lineNo: 1,
      sku: spec.sku === undefined ? "SKU1" : spec.sku,
      description: spec.description ?? "Widget",
      quantity: `${sign}${qty}`,
      unit: "each",
      unitPrice: price,
      amount: `${sign}${amount}`,
    });
    await enqueueMatch(tx, { orgId: org.org.id, invoiceId: inv!.id, revision: inv!.revision });
    return inv!;
  });
}

async function drain() {
  for (let i = 0; i < 50; i++) if (!(await runOnce("test-worker"))) return;
}

const getInvoice = (org: Org, id: string) => withTenant(org.org.id, async (tx) => (await tx.select().from(s.invoices).where(eq(s.invoices.id, id)))[0]!);
const findings = (org: Org, invoiceId: string) =>
  withTenant(org.org.id, (tx) =>
    tx
      .select({ type: s.discrepancies.type, amount: s.discrepancies.amount, exStatus: s.exceptions.status, runStatus: s.checkRuns.status })
      .from(s.discrepancies)
      .innerJoin(s.exceptions, eq(s.exceptions.discrepancyId, s.discrepancies.id))
      .innerJoin(s.checkRuns, eq(s.checkRuns.id, s.discrepancies.checkRunId))
      .where(eq(s.discrepancies.invoiceId, invoiceId)),
  );
const currentFindings = async (org: Org, id: string) => (await findings(org, id)).filter((f) => f.runStatus === "completed").map((f) => f.type).sort();

describe("upload → matching → checks pipeline", () => {
  let org: Org;
  let ref: Ref;
  beforeAll(async () => {
    org = await makeOrg("Engine");
    ref = await seedReference(org);
  });

  it("matches and passes a clean invoice, recording versions and billings", async () => {
    const inv = await createInvoice(org, { qty: "10" });
    await drain();
    const after = await getInvoice(org, inv.id);
    expect(after.status).toBe("passed");
    expect(after.supplierId).toBe(ref.supplierId);
    expect(after.purchaseOrderId).toBe(ref.poId);
    const [run] = await withTenant(org.org.id, (tx) => tx.select().from(s.checkRuns).where(eq(s.checkRuns.invoiceId, inv.id)));
    expect(run).toMatchObject({ status: "completed", ruleSetVersion: "rules@1.0.0", invoiceRevision: 1 });
    expect((run!.referenceSnapshot as { purchaseOrder: { version: number } }).purchaseOrder.version).toBe(1);
    expect((run!.settingsSnapshot as { rounding: { mode: string } }).rounding.mode).toBe("half_up");
    const bal = await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId));
    expect(bal[0]).toMatchObject({ ordered: "100.0000", billed: "10.0000", remaining: "90.0000" });
    const events = await withTenant(org.org.id, (tx) => tx.select({ action: s.auditEvents.action }).from(s.auditEvents).where(eq(s.auditEvents.entityId, inv.id)));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["invoice.matched", "check.completed"]));
  });

  it("flags price variance and routes the invoice to exceptions", async () => {
    const inv = await createInvoice(org, { qty: "5", price: "12.00" });
    await drain();
    expect((await getInvoice(org, inv.id)).status).toBe("exceptions_open");
    const f = await findings(org, inv.id);
    expect(f).toEqual([{ type: "price_variance", amount: "10.0000", exStatus: "open", runStatus: "completed" }]);
  });

  it("detects a duplicate invoice number from the same supplier", async () => {
    const a = await createInvoice(org, { number: "DUP-1", qty: "1" });
    await drain();
    const b = await createInvoice(org, { number: "dup 1", qty: "1" });
    await drain();
    expect(await currentFindings(org, a.id)).toEqual([]);
    expect(await currentFindings(org, b.id)).toEqual(["duplicate_invoice"]);
  });

  it("flags an unknown PO number as a missing reference instead of passing", async () => {
    const inv = await createInvoice(org, { poNumber: "PO-9999", number: "MISS-1", qty: "3" });
    await drain();
    expect((await getInvoice(org, inv.id)).status).toBe("exceptions_open");
    expect(await currentFindings(org, inv.id)).toEqual(["missing_reference"]);
  });
});

describe("retries and idempotency", () => {
  it("running the same check twice creates no duplicate runs, discrepancies or billings", async () => {
    const org = await makeOrg("Idem");
    const ref = await seedReference(org);
    const inv = await createInvoice(org, { qty: "10", price: "11.00" });
    expect(await runMatching(org.org.id, inv.id, 1)).toEqual({ status: "checking" });
    expect(await runMatching(org.org.id, inv.id, 1)).toMatchObject({ status: "skipped" });
    const first = await runCheck(org.org.id, inv.id, 1);
    const second = await runCheck(org.org.id, inv.id, 1);
    expect(first).toMatchObject({ status: "completed", reused: false, discrepancies: 1 });
    expect(second).toMatchObject({ status: "completed", reused: true });
    if (first.status === "completed" && second.status === "completed") expect(second.checkRunId).toBe(first.checkRunId);
    // The queued check job (enqueued by matching) also runs and is a no-op.
    await drain();
    const counts = await withTenant(org.org.id, async (tx) => ({
      runs: (await tx.select().from(s.checkRuns).where(eq(s.checkRuns.invoiceId, inv.id))).length,
      discrepancies: (await tx.select().from(s.discrepancies).where(eq(s.discrepancies.invoiceId, inv.id))).length,
      exceptions: (await tx.select().from(s.exceptions).where(eq(s.exceptions.invoiceId, inv.id))).length,
      billings: (await tx.select().from(s.poLineBillings).where(eq(s.poLineBillings.invoiceId, inv.id))).length,
    }));
    expect(counts).toEqual({ runs: 1, discrepancies: 1, exceptions: 1, billings: 1 });
    const bal = await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId));
    expect(bal[0]!.billed).toBe("10.0000");
  });

  it("ignores a stale revision", async () => {
    const org = await makeOrg("Stale");
    await seedReference(org);
    const inv = await createInvoice(org);
    expect(await runMatching(org.org.id, inv.id, 99)).toMatchObject({ status: "skipped" });
  });

  it("a terminal failure leaves a visible failed state and a processing_failure exception", async () => {
    const org = await makeOrg("Fail");
    await seedReference(org);
    const inv = await createInvoice(org);
    // Simulate a broken pipeline: check job without a match result.
    await withTenant(org.org.id, async (tx) => {
      await tx.update(s.invoices).set({ status: "checking" }).where(eq(s.invoices.id, inv.id));
      await tx.delete(s.jobs).where(eq(s.jobs.orgId, org.org.id));
      const { enqueueCheck } = await import("../src/modules/matching/service");
      await enqueueCheck(tx, { orgId: org.org.id, invoiceId: inv.id, revision: 1 });
    });
    await drain();
    const after = await getInvoice(org, inv.id);
    expect(after.status).toBe("failed");
    expect(after.failureReason).toMatch(/No match result/);
    const ex = await withTenant(org.org.id, (tx) => tx.select().from(s.exceptions).where(eq(s.exceptions.invoiceId, inv.id)));
    expect(ex.map((e) => [e.kind, e.status])).toEqual([["processing_failure", "open"]]);
    const [job] = await withSystem((tx) => tx.select().from(s.jobs).where(and(eq(s.jobs.orgId, org.org.id), eq(s.jobs.type, "invoice.check"))));
    expect(job!.status).toBe("failed");
  });
});

describe("balances: concurrency, partial billing, credit notes, amendments", () => {
  it("two concurrent checks against one PO line never double count the balance", async () => {
    const org = await makeOrg("Concurrent");
    const ref = await seedReference(org);
    const a = await createInvoice(org, { qty: "60", number: "C-A" });
    const b = await createInvoice(org, { qty: "50", number: "C-B" });
    await runMatching(org.org.id, a.id, 1);
    await runMatching(org.org.id, b.id, 1);
    await Promise.all([runCheck(org.org.id, a.id, 1), runCheck(org.org.id, b.id, 1)]);
    const fa = await currentFindings(org, a.id);
    const fb = await currentFindings(org, b.id);
    // Exactly one of the two sees the other's billing and is flagged for the excess.
    expect([...fa, ...fb]).toEqual(["quantity_excess"]);
    const bal = await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId));
    expect(bal[0]).toMatchObject({ billed: "110.0000", remaining: "-10.0000" });
  });

  it("handles partial invoices, then a credit note restores balance", async () => {
    const org = await makeOrg("Partial");
    const ref = await seedReference(org);
    const first = await createInvoice(org, { qty: "70", number: "P-1" });
    await drain();
    const second = await createInvoice(org, { qty: "30", number: "P-2" });
    await drain();
    expect(await currentFindings(org, first.id)).toEqual([]);
    expect(await currentFindings(org, second.id)).toEqual([]);
    const over = await createInvoice(org, { qty: "20", number: "P-3" });
    await drain();
    expect(await currentFindings(org, over.id)).toEqual(["quantity_excess"]);
    const credit = await createInvoice(org, { kind: "credit_note", qty: "20", number: "CN-1" });
    await drain();
    expect((await getInvoice(org, credit.id)).status).toBe("passed");
    expect((await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId)))[0]).toMatchObject({ billed: "100.0000", remaining: "0.0000" });
    // Rejecting the over-billing invoice through the exceptions workflow releases its billings.
    const [ex] = await withTenant(org.org.id, (tx) => tx.select().from(s.exceptions).where(and(eq(s.exceptions.invoiceId, over.id), eq(s.exceptions.status, "open"))));
    await decideException(org.actor, { exceptionId: ex!.id, revision: ex!.revision, decision: "reject_invoice", reason: "Over-billed" });
    expect((await getInvoice(org, over.id)).status).toBe("rejected");
    expect((await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId)))[0]).toMatchObject({ billed: "80.0000", remaining: "20.0000" });
    const released = await withTenant(org.org.id, (tx) => tx.select({ action: s.auditEvents.action }).from(s.auditEvents).where(eq(s.auditEvents.entityId, over.id)));
    expect(released.map((r) => r.action)).toContain("invoice.billings_released");
    // Releasing again is a no-op.
    expect(await withTenant(org.org.id, (tx) => releaseInvoiceBillings(tx, { orgId: org.org.id, invoiceId: over.id, actorUserId: null, reason: "again" }))).toBe(0);
  });

  it("a recheck after a PO amendment supersedes the old run without double counting", async () => {
    const org = await makeOrg("Amend");
    const ref = await seedReference(org, { qty: "10" });
    const inv = await createInvoice(org, { qty: "15" });
    await drain();
    expect(await currentFindings(org, inv.id)).toEqual(["quantity_excess"]);
    const reviewer = await makeUser("rev");
    // Assign the exception so we can see the assignee carry over.
    await withTenant(org.org.id, async (tx) => {
      await tx.insert(s.memberships).values({ orgId: org.org.id, userId: reviewer.id, role: "reviewer" });
      await tx.update(s.exceptions).set({ assigneeUserId: reviewer.id }).where(eq(s.exceptions.invoiceId, inv.id));
    });
    // PO amended: quantity 10 -> 15 (imports module snapshots to po_revisions and bumps version).
    await withTenant(org.org.id, async (tx) => {
      await tx.update(s.poLines).set({ quantity: "12" }).where(eq(s.poLines.id, ref.poLineId));
      await tx.update(s.purchaseOrders).set({ version: 2 }).where(eq(s.purchaseOrders.id, ref.poId));
    });
    await requestRecheck(org.actor, inv.id, 1);
    await drain();
    const f = await findings(org, inv.id);
    expect(f.filter((x) => x.runStatus === "superseded").map((x) => x.exStatus)).toEqual(["dismissed"]);
    const current = f.filter((x) => x.runStatus === "completed");
    expect(current).toEqual([{ type: "quantity_excess", amount: "30.0000", exStatus: "open", runStatus: "completed" }]);
    const ex = await withTenant(org.org.id, (tx) => tx.select().from(s.exceptions).where(and(eq(s.exceptions.invoiceId, inv.id), eq(s.exceptions.status, "open"))));
    expect(ex[0]!.assigneeUserId).toBe(reviewer.id);
    const bal = await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId));
    expect(bal[0]).toMatchObject({ billed: "15.0000" });
    const runs = await withTenant(org.org.id, (tx) => tx.select().from(s.checkRuns).where(eq(s.checkRuns.invoiceId, inv.id)).orderBy(s.checkRuns.startedAt));
    expect(runs.map((r) => [r.status, r.invoiceRevision, (r.referenceSnapshot as { purchaseOrder: { version: number } }).purchaseOrder.version])).toEqual([
      ["superseded", 1, 1],
      ["completed", 2, 2],
    ]);
    // Once amended to cover the full quantity the recheck passes.
    await withTenant(org.org.id, (tx) => tx.update(s.poLines).set({ quantity: "15" }).where(eq(s.poLines.id, ref.poLineId)));
    await requestRecheck(org.actor, inv.id, 2);
    await drain();
    expect((await getInvoice(org, inv.id)).status).toBe("passed");
  });
});

describe("versioned reference data and credit-note references", () => {
  it("only the current version of an approved charge applies", async () => {
    const org = await makeOrg("Charges");
    const ref = await seedReference(org);
    await withTenant(org.org.id, (tx) =>
      tx.insert(s.approvedCharges).values([
        { orgId: org.org.id, supplierId: ref.supplierId, chargeType: "Freight", maxAmount: "50.00", currency: "GBP", validFrom: "2026-01-01", version: 1, supersededAt: new Date() },
        { orgId: org.org.id, supplierId: ref.supplierId, chargeType: "Freight", maxAmount: "20.00", currency: "GBP", validFrom: "2026-01-01", version: 2 },
      ]),
    );
    const inv = await createInvoice(org, { qty: "2", total: "45.00", number: "FR-1" });
    await withTenant(org.org.id, async (tx) => {
      await tx.update(s.invoices).set({ subtotal: "45.00" }).where(eq(s.invoices.id, inv.id));
      await tx.insert(s.invoiceLines).values({ orgId: org.org.id, invoiceId: inv.id, lineNo: 2, lineType: "charge", chargeType: "freight", description: "Freight", amount: "25.00" });
    });
    await drain();
    const f = await findings(org, inv.id);
    expect(f.map((x) => [x.type, x.amount])).toEqual([["unapproved_charge", "5.0000"]]);
  });

  it("a credit note naming the credited invoice number restores that invoice's PO balance", async () => {
    const org = await makeOrg("CreditRef");
    const ref = await seedReference(org);
    await createInvoice(org, { qty: "100", number: "ORIG-77" });
    await drain();
    const credit = await createInvoice(org, { kind: "credit_note", qty: "30", number: "CN-77", poNumber: null });
    await withTenant(org.org.id, (tx) => tx.update(s.invoices).set({ creditsInvoiceNumberRaw: "orig 77" }).where(eq(s.invoices.id, credit.id)));
    await drain();
    const after = await getInvoice(org, credit.id);
    expect(after.purchaseOrderId).toBe(ref.poId);
    expect(after.status).toBe("passed");
    expect((await withTenant(org.org.id, (tx) => poBalances(tx, ref.poId)))[0]).toMatchObject({ billed: "70.0000", remaining: "30.0000" });
  });
});

describe("uncertain matching, permissions and tenant isolation", () => {
  it("routes a weak match to review and resumes after a reviewer confirms it", async () => {
    const org = await makeOrg("Review");
    const ref = await seedReference(org);
    const inv = await createInvoice(org, { poNumber: null, sku: null, description: "Widgets (blue)" });
    await drain();
    const after = await getInvoice(org, inv.id);
    expect(after.status).toBe("matching_review");
    const ex = await withTenant(org.org.id, (tx) => tx.select().from(s.exceptions).where(eq(s.exceptions.invoiceId, inv.id)));
    expect(ex.map((e) => [e.kind, e.status])).toEqual([["matching_review", "open"]]);
    const [line] = await withTenant(org.org.id, (tx) => tx.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceId, inv.id)));

    const viewer = await makeUser("viewer");
    const input = { invoiceId: inv.id, expectedRevision: 1, supplierId: ref.supplierId, purchaseOrderId: ref.poId, lines: [{ invoiceLineId: line!.id, poLineId: ref.poLineId, agreementId: null }] };
    await expect(confirmMatch({ userId: viewer.id, orgId: org.org.id, role: "viewer" }, input)).rejects.toThrow(/invoice.edit/);
    await expect(requestRecheck({ userId: viewer.id, orgId: org.org.id, role: "viewer" }, inv.id, 1)).rejects.toThrow(/invoice.recheck/);
    await expect(confirmMatch(org.actor, { ...input, expectedRevision: 7 })).rejects.toThrow(/changed/);

    await confirmMatch(org.actor, input);
    await drain();
    expect((await getInvoice(org, inv.id)).status).toBe("passed");
    const ex2 = await withTenant(org.org.id, (tx) => tx.select().from(s.exceptions).where(eq(s.exceptions.invoiceId, inv.id)));
    expect(ex2.map((e) => [e.kind, e.status])).toEqual([["matching_review", "dismissed"]]);
  });

  it("cannot match, check or confirm across tenants", async () => {
    const a = await makeOrg("TA");
    const b = await makeOrg("TB");
    const refA = await seedReference(a);
    await seedReference(b);
    const invB = await createInvoice(b);
    await expect(runMatching(a.org.id, invB.id, 1)).rejects.toThrow(/not found/);
    await expect(runCheck(a.org.id, invB.id, 1)).rejects.toThrow(/not found/);
    // Org B cannot point its invoice at org A's supplier / PO.
    await expect(confirmMatch(b.actor, { invoiceId: invB.id, expectedRevision: 1, supplierId: refA.supplierId, purchaseOrderId: refA.poId, lines: [] })).rejects.toThrow(/not found/);
    // Org B's matcher never sees org A's identical reference data.
    await drain();
    const inv = await getInvoice(b, invB.id);
    const supplierOrg = await withSystem(async (tx) => (await tx.select({ orgId: s.suppliers.orgId }).from(s.suppliers).where(eq(s.suppliers.id, inv.supplierId!)))[0]!.orgId);
    expect(supplierOrg).toBe(b.org.id);
    const leaked = await withTenant(a.org.id, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(s.poLineBillings).where(eq(s.poLineBillings.invoiceId, invB.id)));
    expect(leaked[0]!.n).toBe(0);
  });
});

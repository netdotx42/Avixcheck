import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser } from "./helpers";

setupTestEnv();
const { withTenant } = await import("../src/db/tenant");
const s = await import("../src/db/schema");
const svc = await import("../src/modules/exceptions/service");
const rules = await import("../src/modules/exceptions/rules");
const queries = await import("../src/modules/exceptions/queries");

type Role = "admin" | "reviewer" | "viewer";

async function makeTeam(name: string) {
  const base = await makeOrg(name);
  const add = async (role: Role) => {
    const u = await makeUser(role);
    await withTenant(base.org.id, (tx) => tx.insert(s.memberships).values({ orgId: base.org.id, userId: u.id, role }));
    return { user: u, actor: { userId: u.id, orgId: base.org.id, role } };
  };
  return { ...base, reviewer: await add("reviewer"), viewer: await add("viewer") };
}

interface InvoiceOpts {
  amounts?: (string | null)[];
  kind?: "discrepancy" | "extraction_review";
  invoiceStatus?: "exceptions_open" | "extraction_review";
  runStatus?: "completed" | "superseded";
}

/** Insert an invoice with one completed check run and one exception per amount. */
async function seedInvoice(orgId: string, opts: InvoiceOpts = {}) {
  const amounts = opts.amounts ?? ["10.0000"];
  return withTenant(orgId, async (tx) => {
    const [supplier] = await tx.insert(s.suppliers).values({ orgId, code: `S-${randomUUID().slice(0, 6)}`, name: "Acme Metals" }).returning();
    const docId = randomUUID();
    const [doc] = await tx
      .insert(s.documents)
      .values({ id: docId, orgId, storageKey: `org/${orgId}/documents/${docId}.pdf`, sha256: randomUUID(), sizeBytes: 100, mimeType: "application/pdf", originalName: "inv.pdf", scanStatus: "clean" })
      .returning();
    const [inv] = await tx
      .insert(s.invoices)
      .values({ orgId, documentId: doc!.id, status: opts.invoiceStatus ?? "exceptions_open", supplierId: supplier!.id, invoiceNumber: `INV-${randomUUID().slice(0, 6)}`, currency: "GBP", total: "120.0000" })
      .returning();
    const [run] = await tx
      .insert(s.checkRuns)
      .values({ orgId, invoiceId: inv!.id, status: opts.runStatus ?? "completed", ruleSetVersion: "rules@test", settingsSnapshot: {}, referenceSnapshot: {}, invoiceRevision: 1, idempotencyKey: randomUUID() })
      .returning();
    const exs = [];
    for (const amount of amounts) {
      let discrepancyId: string | null = null;
      if ((opts.kind ?? "discrepancy") === "discrepancy") {
        const [d] = await tx
          .insert(s.discrepancies)
          .values({ orgId, checkRunId: run!.id, invoiceId: inv!.id, type: "price_variance", severity: "medium", expectedValue: "10.00", actualValue: "11.00", amount, currency: "GBP", explanation: "Unit price above agreement", references: [{ label: "Agreement", ref: "AG-1", version: 2 }] })
          .returning();
        discrepancyId = d!.id;
      }
      const [e] = await tx
        .insert(s.exceptions)
        .values({ orgId, invoiceId: inv!.id, discrepancyId, kind: opts.kind ?? "discrepancy", title: "Price above agreement" })
        .returning();
      exs.push(e!);
    }
    return { invoice: inv!, run: run!, exceptions: exs };
  });
}

async function invoiceStatus(orgId: string, id: string) {
  const [r] = await withTenant(orgId, (tx) => tx.select({ status: s.invoices.status }).from(s.invoices).where(eq(s.invoices.id, id)));
  return r?.status;
}

async function auditFor(orgId: string, entityId: string) {
  return withTenant(orgId, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.entityType, "exception"), eq(s.auditEvents.entityId, entityId))));
}

describe("exception rules (pure)", () => {
  it("passes an invoice only after every applicable exception is resolved", () => {
    const base = { invoiceStatus: "exceptions_open" as const, hasCompletedCheckRun: true };
    expect(rules.invoiceOutcome({ ...base, exceptions: [{ kind: "discrepancy", status: "open", confirmedCorrectionAmount: null }] })).toBeNull();
    expect(rules.invoiceOutcome({ ...base, exceptions: [{ kind: "discrepancy", status: "accepted_variance", confirmedCorrectionAmount: null }] })).toBe("passed");
    expect(rules.invoiceOutcome({ ...base, exceptions: [{ kind: "discrepancy", status: "correction_requested", confirmedCorrectionAmount: null }] })).toBeNull();
    expect(rules.invoiceOutcome({ ...base, exceptions: [{ kind: "discrepancy", status: "correction_requested", confirmedCorrectionAmount: "1.0000" }] })).toBe("passed");
    expect(rules.invoiceOutcome({ ...base, exceptions: [{ kind: "discrepancy", status: "rejected_invoice", confirmedCorrectionAmount: null }] })).toBe("rejected");
  });

  it("never passes an invoice that has no completed check run or is still in review", () => {
    const ex = [{ kind: "extraction_review" as const, status: "dismissed" as const, confirmedCorrectionAmount: null }];
    expect(rules.invoiceOutcome({ invoiceStatus: "extraction_review", hasCompletedCheckRun: false, exceptions: ex })).toBeNull();
    expect(rules.invoiceOutcome({ invoiceStatus: "exceptions_open", hasCompletedCheckRun: false, exceptions: ex })).toBeNull();
  });

  it("treats dismissing a discrepancy with exposure as an Admin authorisation", () => {
    expect(rules.permissionFor("dismiss", { kind: "discrepancy", amount: "5.0000" })).toBe("exception.accept_variance");
    expect(rules.permissionFor("dismiss", { kind: "discrepancy", amount: "0.0000" })).toBe("exception.decide");
    expect(rules.permissionFor("dismiss", { kind: "discrepancy", amount: null })).toBe("exception.decide");
    expect(rules.permissionFor("dismiss", { kind: "extraction_review", amount: null })).toBe("exception.decide");
    expect(rules.permissionFor("accept_variance", { kind: "discrepancy", amount: null })).toBe("exception.accept_variance");
  });

  it("renders untrusted references defensively", () => {
    expect(queries.normaliseReferences([{ label: "Agreement", ref: "AG-1", version: 2 }, "PO-9", 42, null])).toEqual([
      { label: "Agreement", value: "AG-1 · v2" },
      { label: "Reference", value: "PO-9" },
    ]);
    expect(queries.normaliseReferences({ not: "an array" })).toEqual([]);
  });
});

describe("exception workflow", () => {
  let t: Awaited<ReturnType<typeof makeTeam>>;
  beforeAll(async () => {
    t = await makeTeam("Review Co");
  });

  it("assigns, starts review and decides with a full audit trail", async () => {
    const { invoice, exceptions: [e] } = await seedInvoice(t.org.id);
    const a = await svc.assignException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: t.reviewer.user.id });
    expect(a.revision).toBe(2);
    const r = await svc.startReview(t.reviewer.actor, { exceptionId: e!.id, revision: 2 });
    expect(r.status).toBe("in_review");
    const res = await svc.decideException(t.actor, { exceptionId: e!.id, revision: 3, decision: "accept_variance", reason: "Agreed by phone with buyer", confirmAboveTolerance: true });
    expect(res.exception.status).toBe("accepted_variance");
    expect(res.exception.decidedBy).toBe(t.admin.id);
    expect(res.invoiceStatus).toBe("passed");
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("passed");
    const trail = await auditFor(t.org.id, e!.id);
    expect(trail.map((x) => x.action).sort()).toEqual(["exception.assigned", "exception.decided", "exception.review_started"]);
    const decided = trail.find((x) => x.action === "exception.decided")!;
    expect(decided.data).toMatchObject({ decision: "accept_variance", aboveTolerance: true, amount: "10.0000", reason: "Agreed by phone with buyer" });
    const invAudit = await withTenant(t.org.id, (tx) => tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.entityType, "invoice"), eq(s.auditEvents.entityId, invoice.id))));
    expect(invAudit[0]?.data).toMatchObject({ from: "exceptions_open", to: "passed" });
  });

  it("keeps the invoice open until every exception is resolved", async () => {
    const { invoice, exceptions: [e1, e2] } = await seedInvoice(t.org.id, { amounts: ["5.0000", "0.0000"] });
    await svc.decideException(t.actor, { exceptionId: e1!.id, revision: 1, decision: "accept_variance", reason: "ok per contract", confirmAboveTolerance: true });
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("exceptions_open");
    await svc.decideException(t.reviewer.actor, { exceptionId: e2!.id, revision: 1, decision: "dismiss", reason: "rounding only" });
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("passed");
  });

  it("requires a reason and an explicit authorisation above tolerance", async () => {
    const { exceptions: [e] } = await seedInvoice(t.org.id);
    await expect(svc.decideException(t.actor, { exceptionId: e!.id, revision: 1, decision: "dismiss", reason: "  " })).rejects.toThrow(/reason is required/);
    await expect(svc.decideException(t.actor, { exceptionId: e!.id, revision: 1, decision: "accept_variance", reason: "fine" })).rejects.toThrow(/authorise/);
    expect((await auditFor(t.org.id, e!.id)).length).toBe(0);
  });

  it("rejects the invoice and makes the decision final", async () => {
    const { invoice, exceptions: [e] } = await seedInvoice(t.org.id);
    await svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "reject_invoice", reason: "Not our order" });
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("rejected");
    await expect(svc.decideException(t.actor, { exceptionId: e!.id, revision: 2, decision: "dismiss", reason: "changed mind" })).rejects.toThrow(/already been decided/);
    await expect(svc.assignException(t.actor, { exceptionId: e!.id, revision: 2, assigneeUserId: null })).rejects.toThrow(/cannot be reassigned/);
  });

  it("records realised savings only after a requested correction", async () => {
    const { invoice, exceptions: [e] } = await seedInvoice(t.org.id);
    await expect(svc.recordConfirmedCorrection(t.reviewer.actor, { exceptionId: e!.id, revision: 1, amount: "10", reference: "CN-1" })).rejects.toThrow(/after requesting/);
    await svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "request_correction" });
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("exceptions_open");
    await expect(svc.recordConfirmedCorrection(t.reviewer.actor, { exceptionId: e!.id, revision: 2, amount: "1e3", reference: "CN-1" })).rejects.toThrow(/as a number/);
    await expect(svc.recordConfirmedCorrection(t.reviewer.actor, { exceptionId: e!.id, revision: 2, amount: "-4", reference: "CN-1" })).rejects.toThrow(/greater than zero/);
    await expect(svc.recordConfirmedCorrection(t.reviewer.actor, { exceptionId: e!.id, revision: 2, amount: "1.00001", reference: "CN-1" })).rejects.toThrow(/4 decimal/);
    const res = await svc.recordConfirmedCorrection(t.reviewer.actor, { exceptionId: e!.id, revision: 2, amount: "9.995", reference: "CN-1" });
    expect(res.exception.confirmedCorrectionAmount).toBe("9.9950");
    expect(res.invoiceStatus).toBe("passed");
    await expect(svc.recordConfirmedCorrection(t.reviewer.actor, { exceptionId: e!.id, revision: 3, amount: "1", reference: "CN-2" })).rejects.toThrow(/already recorded/);
  });

  it("never passes an invoice when only review exceptions are dismissed", async () => {
    const { invoice, exceptions: [e] } = await seedInvoice(t.org.id, { kind: "extraction_review", invoiceStatus: "extraction_review" });
    await expect(svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "accept_variance", reason: "x y z" })).rejects.toThrow();
    await svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "dismiss", reason: "duplicate upload" });
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("extraction_review");
  });

  it("ignores discrepancy exceptions from superseded check runs", async () => {
    const old = await seedInvoice(t.org.id, { runStatus: "superseded" });
    const [fresh] = await withTenant(t.org.id, async (tx) => {
      const [run] = await tx.insert(s.checkRuns).values({ orgId: t.org.id, invoiceId: old.invoice.id, status: "completed", ruleSetVersion: "rules@test", settingsSnapshot: {}, referenceSnapshot: {}, invoiceRevision: 2, idempotencyKey: randomUUID() }).returning();
      const [d] = await tx.insert(s.discrepancies).values({ orgId: t.org.id, checkRunId: run!.id, invoiceId: old.invoice.id, type: "arithmetic_error", severity: "low", amount: "0.0000", currency: "GBP", explanation: "Totals" }).returning();
      return tx.insert(s.exceptions).values({ orgId: t.org.id, invoiceId: old.invoice.id, discrepancyId: d!.id, kind: "discrepancy", title: "Totals" }).returning();
    });
    await svc.decideException(t.reviewer.actor, { exceptionId: fresh!.id, revision: 1, decision: "dismiss", reason: "rounding" });
    expect(await invoiceStatus(t.org.id, old.invoice.id)).toBe("passed");
  });
});

describe("permissions per role", () => {
  let t: Awaited<ReturnType<typeof makeTeam>>;
  beforeAll(async () => {
    t = await makeTeam("Perm Co");
  });

  it("viewers cannot assign, review or decide", async () => {
    const { exceptions: [e] } = await seedInvoice(t.org.id);
    await expect(svc.assignException(t.viewer.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: null })).rejects.toThrow(/exception.assign/);
    await expect(svc.startReview(t.viewer.actor, { exceptionId: e!.id, revision: 1 })).rejects.toThrow(/exception.decide/);
    await expect(svc.decideException(t.viewer.actor, { exceptionId: e!.id, revision: 1, decision: "dismiss", reason: "nope" })).rejects.toThrow(/exception.decide/);
    await expect(svc.bulkAssign(t.viewer.actor, { items: [{ id: e!.id, revision: 1 }], assigneeUserId: null })).rejects.toThrow(/exception.assign/);
  });

  it("reviewers cannot accept a variance or dismiss exposure", async () => {
    const { exceptions: [e] } = await seedInvoice(t.org.id);
    await expect(svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "accept_variance", reason: "fine", confirmAboveTolerance: true })).rejects.toThrow(/exception.accept_variance/);
    await expect(svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "dismiss", reason: "fine" })).rejects.toThrow(/exception.accept_variance/);
    const ok = await svc.decideException(t.reviewer.actor, { exceptionId: e!.id, revision: 1, decision: "request_correction", reason: "Price too high" });
    expect(ok.exception.status).toBe("correction_requested");
  });

  it("cannot assign to viewers or non-members", async () => {
    const { exceptions: [e] } = await seedInvoice(t.org.id);
    await expect(svc.assignException(t.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: t.viewer.user.id })).rejects.toThrow(/Viewers cannot/);
    const outsider = await makeUser("outsider");
    await expect(svc.assignException(t.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: outsider.id })).rejects.toThrow(/not a member/);
  });
});

describe("concurrency", () => {
  let t: Awaited<ReturnType<typeof makeTeam>>;
  beforeAll(async () => {
    t = await makeTeam("Race Co");
  });

  it("only one of two concurrent decisions on the same revision wins", async () => {
    const { exceptions: [e] } = await seedInvoice(t.org.id);
    const results = await Promise.allSettled([
      svc.decideException(t.actor, { exceptionId: e!.id, revision: 1, decision: "reject_invoice", reason: "A says reject" }),
      svc.decideException(t.actor, { exceptionId: e!.id, revision: 1, decision: "accept_variance", reason: "B says accept", confirmAboveTolerance: true }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(svc.ConflictError);
    const decisions = (await auditFor(t.org.id, e!.id)).filter((x) => x.action === "exception.decided");
    expect(decisions).toHaveLength(1);
  });

  it("rejects a stale revision instead of overwriting", async () => {
    const { exceptions: [e] } = await seedInvoice(t.org.id);
    await svc.assignException(t.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: t.reviewer.user.id });
    await expect(svc.assignException(t.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: t.admin.id })).rejects.toBeInstanceOf(svc.ConflictError);
  });

  it("concurrent decisions on sibling exceptions both land and the invoice ends passed", async () => {
    const { invoice, exceptions: [e1, e2] } = await seedInvoice(t.org.id, { amounts: ["3.0000", "4.0000"] });
    await Promise.all([
      svc.decideException(t.actor, { exceptionId: e1!.id, revision: 1, decision: "accept_variance", reason: "approved", confirmAboveTolerance: true }),
      svc.decideException(t.actor, { exceptionId: e2!.id, revision: 1, decision: "accept_variance", reason: "approved", confirmAboveTolerance: true }),
    ]);
    expect(await invoiceStatus(t.org.id, invoice.id)).toBe("passed");
  });

  it("bulk assign skips stale and decided rows", async () => {
    const { exceptions: [e1, e2, e3] } = await seedInvoice(t.org.id, { amounts: ["1.0000", "2.0000", "3.0000"] });
    await svc.assignException(t.actor, { exceptionId: e2!.id, revision: 1, assigneeUserId: t.admin.id });
    await svc.decideException(t.actor, { exceptionId: e3!.id, revision: 1, decision: "reject_invoice", reason: "bad" });
    const res = await svc.bulkAssign(t.actor, { items: [{ id: e1!.id, revision: 1 }, { id: e2!.id, revision: 1 }, { id: e3!.id, revision: 1 }], assigneeUserId: t.reviewer.user.id });
    expect(res.assigned).toEqual([e1!.id]);
    expect(res.skipped.map((x) => x.reason).sort()).toEqual(["decided", "stale"]);
  });
});

describe("tenant isolation", () => {
  it("cannot read, assign or decide another organisation's exceptions", async () => {
    const a = await makeTeam("Iso A");
    const b = await makeTeam("Iso B");
    const { exceptions: [e] } = await seedInvoice(a.org.id);
    expect(await queries.getExceptionDetail(b.org.id, e!.id)).toBeNull();
    const listB = await queries.listExceptions(b.org.id, b.admin.id, { status: "all" });
    expect(listB.rows.find((r) => r.id === e!.id)).toBeUndefined();
    await expect(svc.assignException(b.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: null })).rejects.toThrow(/not found/);
    await expect(svc.decideException(b.actor, { exceptionId: e!.id, revision: 1, decision: "reject_invoice", reason: "cross tenant" })).rejects.toThrow(/not found/);
    const res = await svc.bulkAssign(b.actor, { items: [{ id: e!.id, revision: 1 }], assigneeUserId: null });
    expect(res.skipped).toEqual([{ id: e!.id, reason: "not_found" }]);
    // Assigning org B's member to an org A exception is refused too.
    await expect(svc.assignException(a.actor, { exceptionId: e!.id, revision: 1, assigneeUserId: b.reviewer.user.id })).rejects.toThrow(/not a member/);
    const detail = await queries.getExceptionDetail(a.org.id, e!.id);
    expect(detail?.status).toBe("open");
  });
});

describe("list filters", () => {
  it("filters by status, type, assignee, supplier and search, with literal wildcards", async () => {
    const t = await makeTeam("List Co");
    const one = await seedInvoice(t.org.id, { amounts: ["1.0000", "2.0000"] });
    await seedInvoice(t.org.id, { kind: "extraction_review", invoiceStatus: "extraction_review" });
    await svc.assignException(t.actor, { exceptionId: one.exceptions[0]!.id, revision: 1, assigneeUserId: t.reviewer.user.id });
    const all = await queries.listExceptions(t.org.id, t.admin.id, {});
    expect(all.total).toBe(3);
    expect((await queries.listExceptions(t.org.id, t.reviewer.user.id, { assignee: "me" })).total).toBe(1);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { assignee: "unassigned" })).total).toBe(2);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { type: "price_variance" })).total).toBe(2);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { type: "extraction_review" })).total).toBe(1);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { supplierId: one.invoice.supplierId! })).total).toBe(2);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { q: one.invoice.invoiceNumber! })).total).toBe(2);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { q: "%" })).total).toBe(0);
    await svc.decideException(t.actor, { exceptionId: one.exceptions[1]!.id, revision: 1, decision: "reject_invoice", reason: "bad" });
    expect((await queries.listExceptions(t.org.id, t.admin.id, {})).total).toBe(2);
    expect((await queries.listExceptions(t.org.id, t.admin.id, { status: "rejected_invoice" })).total).toBe(1);
  });
});

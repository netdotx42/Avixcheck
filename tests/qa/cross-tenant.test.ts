import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser, expectDbError } from "../helpers";

setupTestEnv();
const { withTenant } = await import("../../src/db/tenant");
const { documents, invoices, jobs, suppliers, exportsTable, auditEvents, purchaseOrders } = await import("../../src/db/schema");
const q = await import("../../src/lib/jobs/queue");
const { idempotencyKey } = await import("../../src/lib/jobs/registry");
const storage = await import("../../src/lib/storage");
const { resolveMembership, listUserOrgs } = await import("../../src/lib/auth/context");
const { overviewMetrics } = await import("../../src/lib/metrics");

type Org = Awaited<ReturnType<typeof makeOrg>>;

async function insertDocument(orgId: string) {
  const id = randomUUID();
  const [doc] = await withTenant(orgId, (tx) =>
    tx
      .insert(documents)
      .values({ id, orgId, storageKey: storage.objectKey(orgId, "documents", id, "pdf"), sha256: randomUUID(), sizeBytes: 10, mimeType: "application/pdf", originalName: "a.pdf" })
      .returning(),
  );
  return doc!;
}

describe("cross-tenant access beyond plain reads", () => {
  let a: Org;
  let b: Org;
  beforeAll(async () => {
    a = await makeOrg("IsoA");
    b = await makeOrg("IsoB");
  });

  it("membership lookups never resolve another org", async () => {
    expect(await resolveMembership(b.admin.id, a.org.id)).toBeNull();
    expect((await listUserOrgs(b.admin.id)).map((o) => o.orgId)).toEqual([b.org.id]);
  });

  it("jobs are invisible and unrecoverable across tenants", async () => {
    const { id } = await withTenant(a.org.id, (tx) => q.enqueue(tx, { orgId: a.org.id, type: "qa.iso", idempotencyKey: idempotencyKey(a.org.id, "qa.iso", "1") }));
    expect(await withTenant(b.org.id, (tx) => tx.select().from(jobs).where(eq(jobs.id, id)))).toHaveLength(0);
    await expect(q.cancelJob(b.actor, id)).rejects.toThrow(/not found/);
    await q.cancelJob(a.actor, id);
    await expect(q.retryJob(b.actor, id)).rejects.toThrow(/not found/);
    const [row] = await withTenant(a.org.id, (tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
    expect(row?.status).toBe("cancelled");
    // B's admin acting on A's job left no audit trail in either org.
    const bAudit = await withTenant(b.org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)));
    expect(bAudit).toHaveLength(0);
  });

  it("an idempotency key reused by another tenant is refused, not merged", async () => {
    const key = `shared-key-${randomUUID()}`;
    await withTenant(a.org.id, (tx) => q.enqueue(tx, { orgId: a.org.id, type: "qa.collide", idempotencyKey: key }));
    await expect(withTenant(b.org.id, (tx) => q.enqueue(tx, { orgId: b.org.id, type: "qa.collide", idempotencyKey: key }))).rejects.toThrow(/another tenant/);
  });

  it("job recovery is admin-only even inside the tenant", async () => {
    const viewer = await makeUser("viewer");
    const { id } = await withTenant(a.org.id, (tx) => q.enqueue(tx, { orgId: a.org.id, type: "qa.role", idempotencyKey: idempotencyKey(a.org.id, "qa.role", "1") }));
    await expect(q.cancelJob({ userId: viewer.id, orgId: a.org.id, role: "viewer" }, id)).rejects.toThrow(/jobs.recover/);
    await expect(q.cancelJob({ userId: viewer.id, orgId: a.org.id, role: "reviewer" }, id)).rejects.toThrow(/jobs.recover/);
  });

  it("storage keys are org-prefixed and foreign keys are refused before signing", async () => {
    const key = storage.objectKey(a.org.id, "documents", randomUUID(), "pdf");
    expect(key.startsWith(`org/${a.org.id}/documents/`)).toBe(true);
    expect(() => storage.assertKeyInOrg(b.org.id, key)).toThrow(/does not belong/);
    await expect(storage.signedGetUrl(b.org.id, key)).rejects.toThrow(/does not belong/);
    expect(() => storage.assertKeyInOrg(a.org.id.slice(0, 8), key)).toThrow();
    expect(() => storage.objectKey("../x", "documents", "y", "pdf")).toThrow(/invalid org id/);
    expect(() => storage.objectKey(a.org.id, "documents", "y", "pdf/../../z")).toThrow(/invalid extension/);
  });

  it("document and export rows of one org are invisible to another", async () => {
    const doc = await insertDocument(a.org.id);
    const [exp] = await withTenant(a.org.id, (tx) => tx.insert(exportsTable).values({ orgId: a.org.id, kind: "invoices", createdBy: a.admin.id }).returning());
    expect(await withTenant(b.org.id, (tx) => tx.select().from(documents).where(eq(documents.id, doc.id)))).toHaveLength(0);
    expect(await withTenant(b.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, exp!.id)))).toHaveLength(0);
  });

  it("the same file hash may exist in two orgs without revealing either", async () => {
    const sha = randomUUID();
    for (const o of [a, b]) {
      const id = randomUUID();
      await withTenant(o.org.id, (tx) =>
        tx.insert(documents).values({ id, orgId: o.org.id, storageKey: storage.objectKey(o.org.id, "documents", id, "pdf"), sha256: sha, sizeBytes: 1, mimeType: "application/pdf", originalName: "x.pdf" }),
      );
    }
    await expectDbError(
      withTenant(a.org.id, (tx) => {
        const id = randomUUID();
        return tx.insert(documents).values({ id, orgId: a.org.id, storageKey: storage.objectKey(a.org.id, "documents", id, "pdf"), sha256: sha, sizeBytes: 1, mimeType: "application/pdf", originalName: "dup.pdf" });
      }),
      /documents_org_sha_uq|duplicate key/,
    );
  });

  it("overview metrics only count the caller's org", async () => {
    const before = await overviewMetrics(b.org.id);
    const doc = await insertDocument(a.org.id);
    await withTenant(a.org.id, (tx) => tx.insert(invoices).values({ orgId: a.org.id, documentId: doc.id, status: "failed" }));
    expect(await overviewMetrics(b.org.id)).toEqual(before);
  });

  // Foreign keys are checked by Postgres without RLS, so on their own they would
  // let a row in org B point at a row in org A. Migration 0006_same_org_refs adds
  // a same-org trigger on every tenant-to-tenant reference to close this.
  it("refuses a row that references another tenant's record", async () => {
    const doc = await insertDocument(a.org.id);
    const [sup] = await withTenant(a.org.id, (tx) => tx.insert(suppliers).values({ orgId: a.org.id, code: `S-${randomUUID().slice(0, 6)}`, name: "A only" }).returning());
    const [po] = await withTenant(a.org.id, (tx) => tx.insert(purchaseOrders).values({ orgId: a.org.id, supplierId: sup!.id, poNumber: `PO-${randomUUID().slice(0, 6)}`, currency: "GBP" }).returning());
    await expectDbError(
      withTenant(b.org.id, (tx) => tx.insert(invoices).values({ orgId: b.org.id, documentId: doc.id, supplierId: sup!.id, purchaseOrderId: po!.id })),
      /same organisation/,
    );
  });
});

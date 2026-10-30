import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser } from "./helpers";

setupTestEnv();
const { withTenant, withSystem } = await import("../src/db/tenant");
const { auditEvents, documents, exportsTable, jobs, memberships } = await import("../src/db/schema");
const { sweepRetention, setLegalHold } = await import("../src/modules/ops/retention");
const { scheduleDailyJobs } = await import("../src/modules/ops/scheduler");

const DAY = 86_400_000;
const NOW = new Date("2026-10-30T12:00:00Z");

async function addDoc(orgId: string, opts: { ageDays: number; retainUntil?: string; legalHold?: boolean }) {
  const id = randomUUID();
  await withTenant(orgId, (tx) =>
    tx.insert(documents).values({
      id,
      orgId,
      storageKey: `org/${orgId}/documents/${id}.pdf`,
      sha256: randomUUID(),
      sizeBytes: 10,
      mimeType: "application/pdf",
      originalName: "inv.pdf",
      scanStatus: "clean",
      retainUntil: opts.retainUntil,
      legalHold: opts.legalHold ?? false,
      createdAt: new Date(NOW.getTime() - opts.ageDays * DAY),
    }),
  );
  return id;
}

function fakeStorage() {
  const deleted: string[] = [];
  return { deleted, deps: { deleteObject: async (k: string) => void deleted.push(k) } };
}

async function getDoc(orgId: string, id: string) {
  return withTenant(orgId, async (tx) => (await tx.select().from(documents).where(eq(documents.id, id)))[0]!);
}

describe("retention sweep", () => {
  it("deletes expired documents, keeps held and in-policy ones, audits each deletion", async () => {
    const { org } = await makeOrg("Ret1");
    const expired = await addDoc(org.id, { ageDays: 3000 });
    const pastRetainUntil = await addDoc(org.id, { ageDays: 10, retainUntil: "2026-10-01" });
    const held = await addDoc(org.id, { ageDays: 3000, legalHold: true });
    const fresh = await addDoc(org.id, { ageDays: 10 });
    const futureRetain = await addDoc(org.id, { ageDays: 3000, retainUntil: "2030-01-01" });
    const s = fakeStorage();

    const r = await sweepRetention(org.id, { now: NOW, deps: s.deps });
    expect(r.documentsDeleted).toBe(2);
    expect(s.deleted.sort()).toEqual([`org/${org.id}/documents/${expired}.pdf`, `org/${org.id}/documents/${pastRetainUntil}.pdf`].sort());
    expect((await getDoc(org.id, expired)).deletedAt).not.toBeNull();
    expect((await getDoc(org.id, held)).deletedAt).toBeNull();
    expect((await getDoc(org.id, fresh)).deletedAt).toBeNull();
    expect((await getDoc(org.id, futureRetain)).deletedAt).toBeNull();

    const events = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "retention.document_deleted")));
    expect(events.map((e) => e.entityId).sort()).toEqual([expired, pastRetainUntil].sort());
    const summary = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "retention.swept")));
    expect(summary).toHaveLength(1);
  });

  it("is idempotent: a second run deletes nothing", async () => {
    const { org } = await makeOrg("Ret2");
    await addDoc(org.id, { ageDays: 3000 });
    const s = fakeStorage();
    expect((await sweepRetention(org.id, { now: NOW, deps: s.deps })).documentsDeleted).toBe(1);
    expect((await sweepRetention(org.id, { now: NOW, deps: s.deps })).documentsDeleted).toBe(0);
    expect(s.deleted).toHaveLength(1);
  });

  it("never touches another tenant's documents", async () => {
    const a = await makeOrg("RetA");
    const b = await makeOrg("RetB");
    const bDoc = await addDoc(b.org.id, { ageDays: 3000 });
    const s = fakeStorage();
    await sweepRetention(a.org.id, { now: NOW, deps: s.deps });
    expect(s.deleted).toHaveLength(0);
    expect((await getDoc(b.org.id, bDoc)).deletedAt).toBeNull();
  });

  it("does not mark a document deleted when the storage delete fails", async () => {
    const { org } = await makeOrg("Ret3");
    const id = await addDoc(org.id, { ageDays: 3000 });
    await expect(sweepRetention(org.id, { now: NOW, deps: { deleteObject: async () => { throw new Error("S3 down"); } } })).rejects.toThrow("S3 down");
    expect((await getDoc(org.id, id)).deletedAt).toBeNull();
  });

  it("expires old exports and processes in bounded batches", async () => {
    const { org, admin } = await makeOrg("Ret4");
    const exportId = randomUUID();
    await withTenant(org.id, (tx) =>
      tx.insert(exportsTable).values({ id: exportId, orgId: org.id, kind: "invoices", status: "ready", storageKey: `org/${org.id}/exports/${exportId}.csv`, createdBy: admin.id, completedAt: new Date(NOW.getTime() - 40 * DAY) }),
    );
    for (let i = 0; i < 3; i++) await addDoc(org.id, { ageDays: 3000 });
    const s = fakeStorage();
    const r1 = await sweepRetention(org.id, { now: NOW, deps: s.deps, batchSize: 2 });
    expect(r1).toMatchObject({ documentsDeleted: 2, exportsExpired: 1, more: true });
    const r2 = await sweepRetention(org.id, { now: NOW, deps: s.deps, batchSize: 2 });
    expect(r2).toMatchObject({ documentsDeleted: 1, exportsExpired: 0, more: false });
    const [exp] = await withTenant(org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, exportId)));
    expect(exp!.status).toBe("expired");
  });
});

describe("legal hold", () => {
  it("is admin-only, needs a reason, is audited, and blocks deletion", async () => {
    const { org, actor } = await makeOrg("Hold1");
    const id = await addDoc(org.id, { ageDays: 3000 });
    const reviewer = await makeUser("rev");
    await withSystem((tx) => tx.insert(memberships).values({ orgId: org.id, userId: reviewer.id, role: "reviewer" }));
    await expect(setLegalHold({ userId: reviewer.id, orgId: org.id, role: "reviewer" }, id, true, "dispute")).rejects.toThrow(/retention.manage/);
    await expect(setLegalHold(actor, id, true, " ")).rejects.toThrow(/reason/i);
    await setLegalHold(actor, id, true, "Supplier dispute #42");
    const s = fakeStorage();
    expect((await sweepRetention(org.id, { now: NOW, deps: s.deps })).documentsDeleted).toBe(0);
    const ev = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.action, "document.legal_hold_set"), eq(auditEvents.entityId, id))));
    expect(ev).toHaveLength(1);
  });

  it("cannot target another tenant's document", async () => {
    const a = await makeOrg("HoldA");
    const b = await makeOrg("HoldB");
    const bDoc = await addDoc(b.org.id, { ageDays: 1 });
    await expect(setLegalHold(a.actor, bDoc, true, "not mine")).rejects.toThrow(/not found/i);
  });
});

describe("scheduler", () => {
  it("enqueues one sweep per org per day, idempotently", async () => {
    const { org } = await makeOrg("Sched");
    const day = new Date("2031-01-02T03:00:00Z");
    await scheduleDailyJobs(day);
    await scheduleDailyJobs(day);
    const rows = await withTenant(org.id, (tx) => tx.select().from(jobs).where(eq(jobs.type, "ops.retention_sweep")));
    expect(rows.filter((j) => j.idempotencyKey.endsWith("2031-01-02"))).toHaveLength(1);
  });
});

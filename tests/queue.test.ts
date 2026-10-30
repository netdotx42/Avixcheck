import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestEnv, makeOrg } from "./helpers";

setupTestEnv();
const { withTenant, withSystem } = await import("../src/db/tenant");
const { jobs } = await import("../src/db/schema");
const q = await import("../src/lib/jobs/queue");
const { registerHandler, idempotencyKey } = await import("../src/lib/jobs/registry");
const { runOnce } = await import("../src/lib/jobs/runner");

async function getJob(id: string) {
  return withSystem(async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!);
}

describe("job queue", () => {
  it("enqueue is idempotent", async () => {
    const { org } = await makeOrg("Q1");
    const key = idempotencyKey(org.id, "test.noop", "x");
    const a = await withTenant(org.id, (tx) => q.enqueue(tx, { orgId: org.id, type: "test.noop", idempotencyKey: key }));
    const b = await withTenant(org.id, (tx) => q.enqueue(tx, { orgId: org.id, type: "test.noop", idempotencyKey: key }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it("never hands the same job to two concurrent workers", async () => {
    const { org } = await makeOrg("Q2");
    const ids = await withTenant(org.id, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 10; i++) out.push((await q.enqueue(tx, { orgId: org.id, type: "test.concurrent", idempotencyKey: idempotencyKey(org.id, "c", i) })).id);
      return out;
    });
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => q.claimNext(`w${i}`, ["test.concurrent"])));
    const claimed = claims.filter(Boolean).map((j) => j!.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.sort()).toEqual([...ids].sort());
  });

  it("retries with backoff and ends in a visible failed state", async () => {
    const { org } = await makeOrg("Q3");
    let calls = 0;
    registerHandler("test.flaky", async () => {
      calls++;
      throw new Error("boom");
    });
    const { id } = await withTenant(org.id, (tx) => q.enqueue(tx, { orgId: org.id, type: "test.flaky", idempotencyKey: idempotencyKey(org.id, "f"), maxAttempts: 2 }));
    expect(await runOnce("w")).toBe(true);
    let j = await getJob(id);
    expect(j.status).toBe("queued");
    expect(j.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(j.lastError).toBe("boom");
    await withSystem((tx) => tx.update(jobs).set({ runAfter: new Date(0) }).where(eq(jobs.id, id)));
    await runOnce("w");
    j = await getJob(id);
    expect(j.status).toBe("failed");
    expect(j.attempts).toBe(2);
    expect(calls).toBe(2);

    // Manual recovery by an admin.
    const { actor } = await makeOrg("other");
    await expect(q.retryJob(actor, id)).rejects.toThrow(); // wrong tenant
    const admin = { userId: (await withSystem(async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!)).createdBy ?? actor.userId, orgId: org.id, role: "admin" as const };
    await q.retryJob(admin, id);
    j = await getJob(id);
    expect(j.status).toBe("queued");
    expect(j.maxAttempts).toBe(5);
    await expect(q.retryJob({ ...admin, role: "reviewer" }, id)).rejects.toThrow(/jobs.recover/);
    await q.cancelJob(admin, id);
    expect((await getJob(id)).status).toBe("cancelled");
  });

  it("fails permanent errors immediately", async () => {
    const { org } = await makeOrg("Q4");
    registerHandler("test.permanent", async () => {
      throw new q.PermanentJobError("bad input");
    });
    const { id } = await withTenant(org.id, (tx) => q.enqueue(tx, { orgId: org.id, type: "test.permanent", idempotencyKey: idempotencyKey(org.id, "p") }));
    await runOnce("w");
    const j = await getJob(id);
    expect(j.status).toBe("failed");
    expect(j.attempts).toBe(1);
  });

  it("reclaims jobs from crashed workers and sweeps exhausted ones", async () => {
    const { org } = await makeOrg("Q5");
    const { id } = await withTenant(org.id, (tx) => q.enqueue(tx, { orgId: org.id, type: "test.stale", idempotencyKey: idempotencyKey(org.id, "s"), maxAttempts: 2 }));
    const first = await q.claimNext("dead-worker", ["test.stale"]);
    expect(first?.id).toBe(id);
    await withSystem((tx) => tx.update(jobs).set({ lockedAt: new Date(Date.now() - 3600_000) }).where(eq(jobs.id, id)));
    const second = await q.claimNext("live-worker", ["test.stale"]);
    expect(second?.id).toBe(id);
    expect(second?.attempts).toBe(2);
    await withSystem((tx) => tx.update(jobs).set({ lockedAt: new Date(Date.now() - 3600_000) }).where(eq(jobs.id, id)));
    expect(await q.claimNext("w3", ["test.stale"])).toBeNull();
    expect(await q.sweepAbandoned()).toBeGreaterThanOrEqual(1);
    expect((await getJob(id)).status).toBe("failed");
  });

  it("a stale worker cannot complete a job it lost", async () => {
    const { org } = await makeOrg("Q6");
    const { id } = await withTenant(org.id, (tx) => q.enqueue(tx, { orgId: org.id, type: "test.lost", idempotencyKey: idempotencyKey(org.id, "l") }));
    const j1 = (await q.claimNext("old", ["test.lost"]))!;
    await withSystem((tx) => tx.update(jobs).set({ lockedAt: new Date(Date.now() - 3600_000) }).where(eq(jobs.id, id)));
    await q.claimNext("new", ["test.lost"]);
    await q.completeJob(j1, "old");
    const j = await getJob(id);
    expect(j.status).toBe("running");
    expect(j.lockedBy).toBe("new");
  });
});

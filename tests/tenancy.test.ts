import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser, expectDbError } from "./helpers";

setupTestEnv();
const { withTenant, withSystem } = await import("../src/db/tenant");
const { db } = await import("../src/db/client");
const { suppliers, auditEvents, memberships } = await import("../src/db/schema");
const orgs = await import("../src/lib/orgs");

describe("tenant isolation (row-level security)", () => {
  let a: Awaited<ReturnType<typeof makeOrg>>;
  let b: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    a = await makeOrg("Alpha");
    b = await makeOrg("Beta");
    await withTenant(a.org.id, (tx) => tx.insert(suppliers).values({ orgId: a.org.id, code: "S1", name: "Alpha Supplier" }));
  });

  it("hides other tenants' rows from reads", async () => {
    const seenByB = await withTenant(b.org.id, (tx) => tx.select().from(suppliers));
    expect(seenByB.find((s) => s.orgId === a.org.id)).toBeUndefined();
    const seenByA = await withTenant(a.org.id, (tx) => tx.select().from(suppliers));
    expect(seenByA.map((s) => s.code)).toContain("S1");
  });

  it("blocks writes into another tenant", async () => {
    await expectDbError(withTenant(b.org.id, (tx) => tx.insert(suppliers).values({ orgId: a.org.id, code: "X", name: "Injected" })), /row-level security/);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(b.org.id, (tx) => tx.update(suppliers).set({ name: "pwned" }).where(eq(suppliers.code, "S1")).returning());
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(b.org.id, (tx) => tx.delete(suppliers).where(eq(suppliers.code, "S1")).returning());
    expect(deleted).toHaveLength(0);
    const still = await withTenant(a.org.id, (tx) => tx.select().from(suppliers).where(eq(suppliers.code, "S1")));
    expect(still[0]?.name).toBe("Alpha Supplier");
  });

  it("sees nothing outside a tenant transaction", async () => {
    const rows = await db().select().from(suppliers);
    expect(rows).toHaveLength(0);
  });

  it("does not leak tenant setting across pooled connections", async () => {
    await withTenant(a.org.id, async () => {});
    const r = await db().execute(sql`select current_setting('app.org_id', true) as v`);
    expect((r.rows[0] as { v: string | null }).v ?? "").toBe("");
  });

  it("rejects malformed org ids", async () => {
    await expect(withTenant("not-a-uuid' or 1=1 --", async () => 1)).rejects.toThrow(/invalid org id/);
  });
});

describe("audit events", () => {
  it("are append-only", async () => {
    const { org } = await makeOrg("Audit");
    const rows = await withTenant(org.id, (tx) => tx.select().from(auditEvents));
    expect(rows.some((r) => r.action === "org.created")).toBe(true);
    await expectDbError(withTenant(org.id, (tx) => tx.update(auditEvents).set({ action: "tampered" })), /append-only/);
    await expectDbError(withTenant(org.id, (tx) => tx.delete(auditEvents)), /append-only/);
    await expectDbError(withSystem((tx) => tx.execute(sql`truncate audit_events cascade`)), /append-only/);
  });
});

describe("organisations and invitations", () => {
  it("invites, accepts once, and enforces matching email", async () => {
    const { org, actor } = await makeOrg("Invites");
    const invitee = await makeUser("reviewer");
    const { token } = await orgs.createInvitation(actor, { email: invitee.email, role: "reviewer" });
    const stranger = await makeUser("stranger");
    await expect(orgs.acceptInvitation(stranger, token)).rejects.toThrow();
    const res = await orgs.acceptInvitation(invitee, token);
    expect(res).toEqual({ orgId: org.id, role: "reviewer" });
    expect(await orgs.acceptInvitation(invitee, token)).toEqual({ orgId: org.id, role: "reviewer" });
    await expect(orgs.acceptInvitation(invitee, "bogus")).rejects.toThrow(/not valid/);
  });

  it("only admins may invite", async () => {
    const { org } = await makeOrg("NoInvite");
    const u = await makeUser("viewer");
    await expect(orgs.createInvitation({ userId: u.id, orgId: org.id, role: "viewer" }, { email: "x@y.z", role: "admin" })).rejects.toThrow(/members.manage/);
  });

  it("keeps at least one admin", async () => {
    const { actor, admin, org } = await makeOrg("LastAdmin");
    await expect(orgs.changeMemberRole(actor, admin.id, "viewer")).rejects.toThrow(/at least one Admin/);
    await expect(orgs.removeMember(actor, admin.id)).rejects.toThrow(/at least one Admin/);
    const m = await withTenant(org.id, (tx) => tx.select().from(memberships));
    expect(m).toHaveLength(1);
  });

  it("cannot manage members of another org", async () => {
    const a = await makeOrg("A2");
    const b = await makeOrg("B2");
    await expect(orgs.changeMemberRole({ ...a.actor, orgId: a.org.id }, b.admin.id, "viewer")).rejects.toThrow(/not found/);
  });
});

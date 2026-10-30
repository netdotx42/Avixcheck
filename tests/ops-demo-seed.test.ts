import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestEnv, makeUser } from "./helpers";

setupTestEnv();
const { withSystem, withTenant } = await import("../src/db/tenant");
const { invoices, organizations, suppliers } = await import("../src/db/schema");
const { seedDemo, DemoSeedRefusedError } = await import("../src/modules/ops/demo-seed");

describe("demo seeder", () => {
  it("refuses to run in production", async () => {
    const u = await makeUser("prod");
    await expect(seedDemo({ appEnv: "production", ownerUserId: u.id })).rejects.toBeInstanceOf(DemoSeedRefusedError);
  });

  it("creates only an is_demo org with reference data, no invoices or results, and is idempotent", async () => {
    const u = await makeUser("demo");
    const r1 = await seedDemo({ appEnv: "development", ownerUserId: u.id });
    expect(r1.created).toBe(true);
    const [org] = await withSystem((tx) => tx.select().from(organizations).where(eq(organizations.id, r1.orgId)));
    expect(org!.isDemo).toBe(true);
    const counts = await withTenant(r1.orgId, async (tx) => ({
      suppliers: (await tx.select().from(suppliers)).length,
      invoices: (await tx.select().from(invoices)).length,
    }));
    expect(counts).toEqual({ suppliers: 3, invoices: 0 });
    const r2 = await seedDemo({ appEnv: "development", ownerUserId: u.id });
    expect(r2).toEqual({ orgId: r1.orgId, created: false });
  });
});

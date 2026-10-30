import { and, eq } from "drizzle-orm";
import { approvedCharges, memberships, organizations, poLines, priceAgreements, purchaseOrders, receipts, suppliers, users } from "@/db/schema";
import { withSystem, withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { createOrganization } from "@/lib/orgs";

export const DEMO_ORG_NAME = "Demo · Northwind Facilities";

export class DemoSeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoSeedRefusedError";
  }
}

/**
 * Seeds a clearly-labelled DEMO organisation with synthetic reference data
 * (suppliers, agreements, POs, charges, receipts). It never writes to a
 * non-demo organisation, never creates invoices, checks or results (those only
 * come from real processing), and refuses to run when APP_ENV=production.
 */
export async function seedDemo(opts: { appEnv: string; ownerUserId?: string; ownerEmail?: string }) {
  if (opts.appEnv === "production") throw new DemoSeedRefusedError("Refusing to seed demo data: APP_ENV=production");

  let ownerId = opts.ownerUserId;
  if (!ownerId) {
    const email = (opts.ownerEmail ?? "demo-admin@avixcheck.invalid").toLowerCase();
    ownerId = await withSystem(async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (u) return u.id;
      const [n] = await tx.insert(users).values({ authSubject: `dev:${email}`, email, name: "Demo Admin" }).returning({ id: users.id });
      return n!.id;
    });
  }

  const existing = await withSystem((tx) =>
    tx
      .select({ id: organizations.id })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.orgId, organizations.id))
      .where(and(eq(organizations.name, DEMO_ORG_NAME), eq(organizations.isDemo, true), eq(memberships.userId, ownerId!)))
      .limit(1),
  );
  if (existing[0]) return { orgId: existing[0].id, created: false };

  const org = await createOrganization(ownerId, { name: DEMO_ORG_NAME, baseCurrency: "GBP", isDemo: true });
  if (!org.isDemo) throw new DemoSeedRefusedError("Organisation was not created as a demo organisation");

  await withTenant(org.id, async (tx) => {
    // Re-check inside the tenant transaction we write with.
    const [o] = await tx.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, org.id));
    if (!o?.isDemo) throw new DemoSeedRefusedError("Target organisation is not a demo organisation");

    const [acme, brightline, cobalt] = await tx
      .insert(suppliers)
      .values([
        { orgId: org.id, code: "ACME", name: "Acme Cleaning Supplies Ltd", taxId: "GB000000001", currency: "GBP", aliases: ["Acme Cleaning", "ACME CS"] },
        { orgId: org.id, code: "BRIGHT", name: "Brightline Electrical", taxId: "GB000000002", currency: "GBP", aliases: ["Brightline"] },
        { orgId: org.id, code: "COBALT", name: "Cobalt Office Furniture", taxId: "GB000000003", currency: "EUR", aliases: [] },
      ])
      .returning();

    await tx.insert(priceAgreements).values([
      { orgId: org.id, supplierId: acme!.id, agreementRef: "AG-ACME-2026", sku: "MOP-100", description: "Microfibre mop head", unitPrice: "4.250000", currency: "GBP", unit: "each", discountPct: "0", validFrom: "2026-01-01", validTo: "2026-12-31" },
      { orgId: org.id, supplierId: acme!.id, agreementRef: "AG-ACME-2026", sku: "DET-5L", description: "Detergent 5L", unitPrice: "12.900000", currency: "GBP", unit: "each", discountPct: "5.0000", minQuantity: "20.0000", validFrom: "2026-01-01", validTo: "2026-12-31" },
      { orgId: org.id, supplierId: brightline!.id, agreementRef: "AG-BL-01", sku: "LED-T8", description: "LED tube T8 1500mm", unitPrice: "8.500000", currency: "GBP", unit: "each", discountPct: "0", validFrom: "2026-03-01", validTo: null },
      { orgId: org.id, supplierId: cobalt!.id, agreementRef: "AG-CO-2026", sku: "CHAIR-ERG", description: "Ergonomic chair", unitPrice: "189.000000", currency: "EUR", unit: "each", discountPct: "0", validFrom: "2026-01-01", validTo: "2026-06-30" },
    ]);

    await tx.insert(approvedCharges).values([
      { orgId: org.id, supplierId: acme!.id, chargeType: "delivery", maxAmount: "15.0000", currency: "GBP", validFrom: "2026-01-01" },
    ]);

    const [po1, po2] = await tx
      .insert(purchaseOrders)
      .values([
        { orgId: org.id, supplierId: acme!.id, poNumber: "DEMO-PO-1001", currency: "GBP", issuedOn: "2026-09-01" },
        { orgId: org.id, supplierId: brightline!.id, poNumber: "DEMO-PO-1002", currency: "GBP", issuedOn: "2026-09-15" },
      ])
      .returning();

    const lines = await tx
      .insert(poLines)
      .values([
        { orgId: org.id, poId: po1!.id, lineNo: 1, sku: "MOP-100", description: "Microfibre mop head", quantity: "200.0000", unit: "each", unitPrice: "4.250000" },
        { orgId: org.id, poId: po1!.id, lineNo: 2, sku: "DET-5L", description: "Detergent 5L", quantity: "40.0000", unit: "each", unitPrice: "12.900000" },
        { orgId: org.id, poId: po2!.id, lineNo: 1, sku: "LED-T8", description: "LED tube T8 1500mm", quantity: "120.0000", unit: "each", unitPrice: "8.500000" },
      ])
      .returning();

    await tx.insert(receipts).values([
      { orgId: org.id, poLineId: lines[0]!.id, receiptRef: "DEMO-GRN-501", quantity: "150.0000", receivedOn: "2026-09-20" },
    ]);

    await audit(tx, {
      orgId: org.id,
      actorUserId: ownerId!,
      action: "demo.seeded",
      entityType: "organization",
      entityId: org.id,
      data: { suppliers: 3, agreements: 4, purchaseOrders: 2, poLines: lines.length, note: "synthetic demo reference data" },
    });
  });

  return { orgId: org.id, created: true };
}

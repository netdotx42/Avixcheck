import { sql } from "drizzle-orm";
import { ShoppingCart } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";

export const metadata = { title: "Purchase Orders" };

// Foundation placeholder: the owning module replaces this page with the full list view.
export default async function Page() {
  const ctx = await pageContext("reference.view");
  const count = await withTenant(ctx.orgId, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from purchase_orders`);
    return (r.rows[0] as { n: number }).n;
  });
  return (
    <>
      <PageHeader title="Purchase Orders" />
      {count === 0 ? (
        <EmptyState icon={ShoppingCart} title="No purchase orders yet" body="Import purchase orders and lines from a CSV template. Amendments keep earlier versions." />
      ) : (
        <p className="text-sm text-muted">{count} records.</p>
      )}
    </>
  );
}

import { sql } from "drizzle-orm";
import { Building2 } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";

export const metadata = { title: "Suppliers & Agreements" };

// Foundation placeholder: the owning module replaces this page with the full list view.
export default async function Page() {
  const ctx = await pageContext("reference.view");
  const count = await withTenant(ctx.orgId, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from suppliers`);
    return (r.rows[0] as { n: number }).n;
  });
  return (
    <>
      <PageHeader title="Suppliers & Agreements" />
      {count === 0 ? (
        <EmptyState icon={Building2} title="No suppliers yet" body="Import suppliers and dated price agreements from CSV templates to start matching invoices." />
      ) : (
        <p className="text-sm text-muted">{count} records.</p>
      )}
    </>
  );
}

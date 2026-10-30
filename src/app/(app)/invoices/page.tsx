import { sql } from "drizzle-orm";
import { FileText } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";

export const metadata = { title: "Invoices" };

// Foundation placeholder: the owning module replaces this page with the full list view.
export default async function Page() {
  const ctx = await pageContext("invoice.view");
  const count = await withTenant(ctx.orgId, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from invoices`);
    return (r.rows[0] as { n: number }).n;
  });
  return (
    <>
      <PageHeader title="Invoices" />
      {count === 0 ? (
        <EmptyState icon={FileText} title="No invoices yet" body="Upload supplier PDF invoices to scan, extract and check them against your purchase orders and agreements." />
      ) : (
        <p className="text-sm text-muted">{count} records.</p>
      )}
    </>
  );
}

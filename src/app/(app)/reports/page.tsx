import { sql } from "drizzle-orm";
import { BarChart3 } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";

export const metadata = { title: "Reports" };

// Foundation placeholder: the owning module replaces this page with the full list view.
export default async function Page() {
  const ctx = await pageContext("report.view");
  const count = await withTenant(ctx.orgId, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from invoices`);
    return (r.rows[0] as { n: number }).n;
  });
  return (
    <>
      <PageHeader title="Reports" />
      {count === 0 ? (
        <EmptyState icon={BarChart3} title="No report data yet" body="Reports summarise checked invoices, exposure, confirmed corrections and processing failures once invoices are processed." />
      ) : (
        <p className="text-sm text-muted">{count} records.</p>
      )}
    </>
  );
}

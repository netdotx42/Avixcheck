import { sql } from "drizzle-orm";
import { ShieldAlert } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";

export const metadata = { title: "Exceptions" };

// Foundation placeholder: the owning module replaces this page with the full list view.
export default async function Page() {
  const ctx = await pageContext("exception.view");
  const count = await withTenant(ctx.orgId, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from exceptions`);
    return (r.rows[0] as { n: number }).n;
  });
  return (
    <>
      <PageHeader title="Exceptions" />
      {count === 0 ? (
        <EmptyState icon={ShieldAlert} title="No exceptions" body="Discrepancies and records needing review will appear here for assignment and decision." />
      ) : (
        <p className="text-sm text-muted">{count} records.</p>
      )}
    </>
  );
}

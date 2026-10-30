import Link from "next/link";
import { Upload } from "lucide-react";
import { PageHeader, Stat } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { overviewMetrics } from "@/lib/metrics";
import { formatAmounts } from "@/lib/format";
import { can } from "@/lib/auth/permissions";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await pageContext("org.view");
  const m = await overviewMetrics(ctx.orgId);
  return (
    <>
      <PageHeader
        title="Overview"
        description={`${ctx.orgName} · invoice checks before payment`}
        actions={can(ctx.role, "invoice.upload") ? <Link href="/invoices/upload" className="btn btn-primary"><Upload aria-hidden className="size-4" />Upload invoices</Link> : null}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Invoices (30 days)" value={String(m.invoicesLast30d)} hint={`${m.invoicesTotal} all time`} />
        <Stat label="Unresolved discrepancies" value={String(m.unresolvedExceptions)} hint="Open or in review" />
        <Stat label="Processing failures" value={String(m.processingFailures)} hint="Failed invoices and jobs needing recovery" />
        <Stat label="Confirmed corrections" value={formatAmounts(m.confirmedCorrections)} hint="Realised savings: supplier-confirmed only" tone="savings" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Stat label="Potential exposure" value={formatAmounts(m.potentialExposure)} hint="Sum of unresolved discrepancy amounts. Not savings until a correction is confirmed." tone="exposure" />
        <div className="card p-5 text-sm text-muted">
          <div className="text-xs font-medium uppercase tracking-wide">About these figures</div>
          <p className="mt-2">Passed checks are not payment approval. AvixCheck does not execute payments or write back to your ERP.</p>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import { BarChart3, Upload } from "lucide-react";
import { PageHeader, Stat } from "@/components/ui/page";
import { pageContext } from "@/lib/auth/page-guard";
import { overviewMetrics, overviewTrends } from "@/lib/metrics";
import { formatAmounts } from "@/lib/format";
import { can } from "@/lib/auth/permissions";
import { DemoBanner, FailuresCard, OutcomesTable, UnresolvedTable, VolumeChart } from "@/modules/reports/ui";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await pageContext("org.view");
  const [m, t] = await Promise.all([overviewMetrics(ctx.orgId), overviewTrends(ctx.orgId)]);
  return (
    <>
      <PageHeader
        title="Overview"
        description={`${ctx.orgName} · invoice checks before payment`}
        actions={
          <>
            {can(ctx.role, "report.view") && <Link href="/reports" className="btn btn-secondary"><BarChart3 aria-hidden className="size-4" />Reports</Link>}
            {can(ctx.role, "invoice.upload") && <Link href="/invoices/upload" className="btn btn-primary"><Upload aria-hidden className="size-4" />Upload invoices</Link>}
          </>
        }
      />
      {ctx.isDemo && <DemoBanner />}
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
          <p className="mt-2">Passed checks are not payment approval. AvixCheck does not execute payments or write back to your ERP. Amounts in different currencies are never added together.</p>
        </div>
      </div>

      <div className="mt-6">
        <VolumeChart points={t.volume} bucket="week" title="Invoices received, last 12 weeks" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <UnresolvedTable
          title="Unresolved by type"
          keyHeader="Type"
          groups={t.byType}
          emptyText="No unresolved discrepancies. New ones appear here as invoices are checked."
          linkFor={(k) => `/exceptions?type=${encodeURIComponent(k)}`}
        />
        <UnresolvedTable
          title="Unresolved by age"
          description="Time since the exception was raised."
          keyHeader="Age"
          groups={t.byAge}
          labelFor={(k) => k}
          emptyText="Nothing waiting for review."
        />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <OutcomesTable outcomes={t.outcomes} />
        <FailuresCard failures={t.failures} canRecover={can(ctx.role, "jobs.recover")} />
      </div>
    </>
  );
}

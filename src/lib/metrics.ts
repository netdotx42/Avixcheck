import { sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";

export interface CurrencyAmount {
  currency: string;
  amount: string;
}

export interface OverviewMetrics {
  invoicesLast30d: number;
  invoicesTotal: number;
  unresolvedExceptions: number;
  processingFailures: number;
  /** Potential exposure: discrepancy amounts on unresolved exceptions. NOT savings. */
  potentialExposure: CurrencyAmount[];
  /** Realised savings: confirmed supplier corrections only. */
  confirmedCorrections: CurrencyAmount[];
}

/** All figures are computed in SQL NUMERIC; amounts are returned as strings. */
export async function overviewMetrics(orgId: string): Promise<OverviewMetrics> {
  return withTenant(orgId, async (tx) => {
    const counts = await tx.execute(sql`
      select
        (select count(*)::int from invoices where created_at > now() - interval '30 days') as invoices_30d,
        (select count(*)::int from invoices) as invoices_total,
        (select count(*)::int from exceptions where status in ('open', 'in_review')) as unresolved,
        (select count(*)::int from invoices where status = 'failed')
          + (select count(*)::int from jobs where status = 'failed') as failures`);
    const exposure = await tx.execute(sql`
      select coalesce(d.currency, 'UNK') as currency, sum(abs(d.amount))::text as amount
      from exceptions e join discrepancies d on d.id = e.discrepancy_id
      where e.status in ('open', 'in_review') and d.amount is not null
      group by 1 order by 1`);
    const savings = await tx.execute(sql`
      select coalesce(i.currency, 'UNK') as currency, sum(e.confirmed_correction_amount)::text as amount
      from exceptions e join invoices i on i.id = e.invoice_id
      where e.confirmed_correction_amount is not null
      group by 1 order by 1`);
    const c = counts.rows[0] as { invoices_30d: number; invoices_total: number; unresolved: number; failures: number };
    return {
      invoicesLast30d: c.invoices_30d,
      invoicesTotal: c.invoices_total,
      unresolvedExceptions: c.unresolved,
      processingFailures: c.failures,
      potentialExposure: exposure.rows as unknown as CurrencyAmount[],
      confirmedCorrections: savings.rows as unknown as CurrencyAmount[],
    };
  });
}

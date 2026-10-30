import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { dec } from "@/lib/money/decimal";
import type { CurrencyAmount } from "@/lib/metrics";
import { daysBetween, isoDaysAgo, type ReportFilters } from "./filters";

/**
 * Reporting queries. All money is aggregated in SQL NUMERIC and returned as
 * strings, grouped per currency (amounts in different currencies are never
 * added together). Every query runs inside the caller's tenant transaction, so
 * RLS limits it to one organisation.
 *
 * Potential exposure and realised savings are different things and are never
 * combined:
 * - potential exposure: discrepancy amounts on exceptions still open or in review
 * - awaiting correction: supplier asked to correct, not yet confirmed
 * - accepted variance: an authorised person accepted the difference (not a saving)
 * - realised savings: `confirmed_correction_amount`, recorded only when a supplier correction is confirmed
 *
 * Discrepancies from superseded check runs are excluded so a re-check never
 * double counts.
 */

export const UNRESOLVED_STATUSES = ["open", "in_review"] as const;

/** Rows matching the filters on invoices aliased `i`. */
export function invoiceFilterSql(f: ReportFilters): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.from) parts.push(sql`i.created_at >= (${f.from}::date)::timestamp at time zone 'UTC'`);
  if (f.to) parts.push(sql`i.created_at < ((${f.to}::date + 1)::timestamp at time zone 'UTC')`);
  if (f.supplierId) parts.push(sql`i.supplier_id = ${f.supplierId}`);
  return sql.join(parts, sql` and `);
}

/** Exceptions joined to their (optional) discrepancy, excluding superseded runs. */
const currentExceptions = sql`
  exceptions e
  join invoices i on i.id = e.invoice_id
  left join discrepancies d on d.id = e.discrepancy_id
  left join check_runs cr on cr.id = d.check_run_id`;
const notSuperseded = sql`(cr.id is null or cr.status <> 'superseded')`;

const rows = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as unknown as T[];

// ───────────────────────── Summary ─────────────────────────

export interface InvoiceSummary {
  total: number;
  invoices: number;
  creditNotes: number;
  passed: number;
  exceptionsOpen: number;
  inProgress: number;
  needsReview: number;
  failed: number;
  rejected: number;
}

export async function invoiceSummary(tx: Tx, f: ReportFilters): Promise<InvoiceSummary> {
  const [r] = await rows<Record<keyof InvoiceSummary, number>>(
    tx,
    sql`select
      count(*)::int as "total",
      count(*) filter (where kind = 'invoice')::int as "invoices",
      count(*) filter (where kind = 'credit_note')::int as "creditNotes",
      count(*) filter (where status = 'passed')::int as "passed",
      count(*) filter (where status = 'exceptions_open')::int as "exceptionsOpen",
      count(*) filter (where status in ('uploaded', 'scanning', 'extracting', 'matching', 'checking'))::int as "inProgress",
      count(*) filter (where status in ('extraction_review', 'matching_review'))::int as "needsReview",
      count(*) filter (where status in ('failed', 'quarantined'))::int as "failed",
      count(*) filter (where status = 'rejected')::int as "rejected"
    from invoices i where ${invoiceFilterSql(f)}`,
  );
  return r!;
}

/** Totals billed per currency, invoices and credit notes kept apart. Credit notes are shown as positive magnitudes. */
export async function billedTotals(tx: Tx, f: ReportFilters): Promise<{ currency: string; invoiced: string; credited: string }[]> {
  return rows(
    tx,
    sql`select coalesce(i.currency, 'UNK') as currency,
      coalesce(sum(i.total) filter (where i.kind = 'invoice'), 0)::text as invoiced,
      coalesce(sum(abs(i.total)) filter (where i.kind = 'credit_note'), 0)::text as credited
    from invoices i where ${invoiceFilterSql(f)} and i.total is not null
    group by 1 order by 1`,
  );
}

// ───────────────────────── Volume over time ─────────────────────────

export type Bucket = "day" | "week" | "month";

export function chooseBucket(from: string, to: string): Bucket {
  const days = daysBetween(from, to);
  if (days <= 45) return "day";
  if (days <= 210) return "week";
  return "month";
}

export interface VolumePoint {
  period: string;
  invoices: number;
  creditNotes: number;
  failed: number;
}

/** Received invoices per period, with empty periods filled in. `from`/`to` are required here. */
export async function invoiceVolume(tx: Tx, f: ReportFilters & { from: string; to: string }, bucket: Bucket = chooseBucket(f.from, f.to)): Promise<VolumePoint[]> {
  const unit = sql.raw(`'${bucket}'`);
  const step = sql.raw(`'1 ${bucket}'`);
  return rows(
    tx,
    sql`with periods as (
        select generate_series(date_trunc(${unit}, ${f.from}::date::timestamp), date_trunc(${unit}, ${f.to}::date::timestamp), ${step}::interval) as p
      ), counts as (
        select date_trunc(${unit}, i.created_at at time zone 'UTC') as p,
          count(*) filter (where i.kind = 'invoice')::int as invoices,
          count(*) filter (where i.kind = 'credit_note')::int as credit_notes,
          count(*) filter (where i.status in ('failed', 'quarantined'))::int as failed
        from invoices i where ${invoiceFilterSql(f)} group by 1
      )
      select to_char(periods.p, 'YYYY-MM-DD') as period,
        coalesce(c.invoices, 0) as invoices, coalesce(c.credit_notes, 0) as "creditNotes", coalesce(c.failed, 0) as failed
      from periods left join counts c on c.p = periods.p order by periods.p`,
  );
}

// ───────────────────────── Exposure vs savings ─────────────────────────

export interface OutcomeByCurrency {
  currency: string;
  /** Unresolved (open / in review) discrepancy amounts. Not savings. */
  potentialExposure: string;
  /** Supplier correction requested but not yet confirmed. Not savings. */
  awaitingCorrection: string;
  /** Variances accepted by an authorised person. Neither exposure nor savings. */
  acceptedVariance: string;
  /** Confirmed supplier corrections only. */
  realisedSavings: string;
}

export async function outcomesByCurrency(tx: Tx, f: ReportFilters): Promise<OutcomeByCurrency[]> {
  return rows(
    tx,
    sql`select coalesce(d.currency, i.currency, 'UNK') as currency,
      coalesce(sum(abs(d.amount)) filter (where e.status in ('open', 'in_review')), 0)::text as "potentialExposure",
      coalesce(sum(abs(d.amount)) filter (where e.status = 'correction_requested' and e.confirmed_correction_amount is null), 0)::text as "awaitingCorrection",
      coalesce(sum(abs(d.amount)) filter (where e.status = 'accepted_variance'), 0)::text as "acceptedVariance",
      coalesce(sum(e.confirmed_correction_amount), 0)::text as "realisedSavings"
    from ${currentExceptions}
    where ${notSuperseded} and ${invoiceFilterSql(f)}
      and (d.amount is not null or e.confirmed_correction_amount is not null)
    group by 1 order by 1`,
  );
}

// ───────────────────────── Unresolved discrepancies ─────────────────────────

export interface UnresolvedGroup {
  key: string;
  count: number;
  exposure: CurrencyAmount[];
}

function groupAmounts(raw: { key: string; count: number; currency: string | null; amount: string | null }[], order: string[] = []): UnresolvedGroup[] {
  const map = new Map<string, UnresolvedGroup>();
  for (const r of raw) {
    const g = map.get(r.key) ?? { key: r.key, count: 0, exposure: [] };
    g.count += r.count;
    if (r.currency && r.amount !== null && !dec(r.amount).isZero()) g.exposure.push({ currency: r.currency, amount: r.amount });
    map.set(r.key, g);
  }
  const list = [...map.values()];
  if (order.length) list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  else list.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return list;
}

/** Open / in-review exceptions grouped by discrepancy type (or exception kind for review and failure items). */
export async function unresolvedByType(tx: Tx, f: ReportFilters): Promise<UnresolvedGroup[]> {
  const raw = await rows<{ key: string; count: number; currency: string | null; amount: string | null }>(
    tx,
    sql`select coalesce(d.type::text, e.kind::text) as key, coalesce(d.currency, i.currency) as currency,
      count(*)::int as count, sum(abs(d.amount))::text as amount
    from ${currentExceptions}
    where ${notSuperseded} and e.status in ('open', 'in_review') and ${invoiceFilterSql(f)}
    group by 1, 2`,
  );
  return groupAmounts(raw);
}

export const AGE_BUCKETS = ["0–7 days", "8–30 days", "31–90 days", "Over 90 days"] as const;

/** Open / in-review exceptions by age since they were raised. */
export async function unresolvedByAge(tx: Tx, f: ReportFilters, now: Date = new Date()): Promise<UnresolvedGroup[]> {
  const raw = await rows<{ key: string; count: number; currency: string | null; amount: string | null }>(
    tx,
    sql`select case
        when ${now.toISOString()}::timestamptz - e.created_at <= interval '7 days' then ${AGE_BUCKETS[0]}
        when ${now.toISOString()}::timestamptz - e.created_at <= interval '30 days' then ${AGE_BUCKETS[1]}
        when ${now.toISOString()}::timestamptz - e.created_at <= interval '90 days' then ${AGE_BUCKETS[2]}
        else ${AGE_BUCKETS[3]} end as key,
      coalesce(d.currency, i.currency) as currency, count(*)::int as count, sum(abs(d.amount))::text as amount
    from ${currentExceptions}
    where ${notSuperseded} and e.status in ('open', 'in_review') and ${invoiceFilterSql(f)}
    group by 1, 2`,
  );
  const groups = groupAmounts(raw, [...AGE_BUCKETS]);
  return AGE_BUCKETS.map((k) => groups.find((g) => g.key === k) ?? { key: k, count: 0, exposure: [] });
}

// ───────────────────────── Processing failures ─────────────────────────

export interface FailureSummary {
  failedInvoices: number;
  quarantinedInvoices: number;
  failedJobs: number;
  openProcessingExceptions: number;
  failedJobsByType: { type: string; count: number }[];
  recentInvoices: { id: string; status: string; reason: string | null; name: string; updatedAt: string }[];
}

/** Failures needing recovery. Failed jobs are org-wide (not date-filtered): they all need attention. */
export async function processingFailures(tx: Tx, f: ReportFilters): Promise<FailureSummary> {
  const [c] = await rows<{ failed: number; quarantined: number; processing: number }>(
    tx,
    sql`select
      (select count(*)::int from invoices i where i.status = 'failed' and ${invoiceFilterSql(f)}) as failed,
      (select count(*)::int from invoices i where i.status = 'quarantined' and ${invoiceFilterSql(f)}) as quarantined,
      (select count(*)::int from exceptions e join invoices i on i.id = e.invoice_id
        where e.kind = 'processing_failure' and e.status in ('open', 'in_review') and ${invoiceFilterSql(f)}) as processing`,
  );
  const byType = await rows<{ type: string; count: number }>(tx, sql`select type, count(*)::int as count from jobs where status = 'failed' group by 1 order by 2 desc, 1`);
  const recent = await rows<{ id: string; status: string; reason: string | null; name: string; updatedAt: string }>(
    tx,
    sql`select i.id, i.status::text as status, i.failure_reason as reason, coalesce(i.invoice_number, doc.original_name) as name,
      to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt"
    from invoices i join documents doc on doc.id = i.document_id
    where i.status in ('failed', 'quarantined') and ${invoiceFilterSql(f)}
    order by i.updated_at desc limit 10`,
  );
  return {
    failedInvoices: c!.failed,
    quarantinedInvoices: c!.quarantined,
    openProcessingExceptions: c!.processing,
    failedJobs: byType.reduce((n, r) => n + r.count, 0),
    failedJobsByType: byType,
    recentInvoices: recent,
  };
}

// ───────────────────────── Suppliers ─────────────────────────

export interface SupplierRow {
  supplierId: string | null;
  name: string;
  code: string | null;
  invoices: number;
  openExceptions: number;
  exposure: CurrencyAmount[];
  realised: CurrencyAmount[];
}

/** Per-supplier breakdown, busiest first. Invoices without a matched supplier are grouped as "Unmatched supplier". */
export async function supplierBreakdown(tx: Tx, f: ReportFilters, page = 1, pageSize = 20): Promise<{ rows: SupplierRow[]; total: number }> {
  const [t] = await rows<{ n: number }>(tx, sql`select count(distinct coalesce(i.supplier_id::text, '-'))::int as n from invoices i where ${invoiceFilterSql(f)}`);
  const base = await rows<{ supplierId: string | null; name: string | null; code: string | null; invoices: number }>(
    tx,
    sql`select i.supplier_id as "supplierId", s.name, s.code, count(*)::int as invoices
    from invoices i left join suppliers s on s.id = i.supplier_id
    where ${invoiceFilterSql(f)}
    group by 1, 2, 3 order by 4 desc, 2 nulls last
    limit ${pageSize} offset ${(page - 1) * pageSize}`,
  );
  if (base.length === 0) return { rows: [], total: t!.n };
  const ids = base.map((b) => b.supplierId).filter((x): x is string => !!x);
  const includeNull = base.some((b) => b.supplierId === null);
  const idFilter = sql`(${ids.length ? sql`i.supplier_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`}${includeNull ? sql` or i.supplier_id is null` : sql``})`;
  const amounts = await rows<{ supplierId: string | null; currency: string; open: number; exposure: string; realised: string }>(
    tx,
    sql`select i.supplier_id as "supplierId", coalesce(d.currency, i.currency, 'UNK') as currency,
      count(*) filter (where e.status in ('open', 'in_review'))::int as open,
      coalesce(sum(abs(d.amount)) filter (where e.status in ('open', 'in_review')), 0)::text as exposure,
      coalesce(sum(e.confirmed_correction_amount), 0)::text as realised
    from ${currentExceptions}
    where ${notSuperseded} and ${invoiceFilterSql(f)} and ${idFilter}
    group by 1, 2`,
  );
  return {
    total: t!.n,
    rows: base.map((b) => {
      const mine = amounts.filter((a) => a.supplierId === b.supplierId);
      const nonZero = (k: "exposure" | "realised") => mine.filter((a) => !dec(a[k]).isZero()).map((a) => ({ currency: a.currency, amount: a[k] }));
      return {
        supplierId: b.supplierId,
        name: b.name ?? "Unmatched supplier",
        code: b.code,
        invoices: b.invoices,
        openExceptions: mine.reduce((n, a) => n + a.open, 0),
        exposure: nonZero("exposure"),
        realised: nonZero("realised"),
      };
    }),
  };
}

export async function supplierOptions(tx: Tx): Promise<{ id: string; label: string }[]> {
  return rows(tx, sql`select id, name || ' (' || code || ')' as label from suppliers order by name limit 1000`);
}

// ───────────────────────── Full report ─────────────────────────

export interface ReportData {
  range: { from: string; to: string; bucket: Bucket };
  summary: InvoiceSummary;
  billed: Awaited<ReturnType<typeof billedTotals>>;
  volume: VolumePoint[];
  outcomes: OutcomeByCurrency[];
  byType: UnresolvedGroup[];
  byAge: UnresolvedGroup[];
  failures: FailureSummary;
  suppliers: { rows: SupplierRow[]; total: number };
}

export const DEFAULT_RANGE_DAYS = 90;

/** Fill in a default range (last 90 days) so the volume chart has bounds. */
export function withDefaultRange(f: ReportFilters, now = new Date()): ReportFilters & { from: string; to: string } {
  const to = f.to ?? isoDaysAgo(0, now);
  const from = f.from ?? (f.to ? isoDaysAgo(DEFAULT_RANGE_DAYS, new Date(`${f.to}T00:00:00Z`)) : isoDaysAgo(DEFAULT_RANGE_DAYS, now));
  return { ...f, from, to };
}

export async function reportData(orgId: string, filters: ReportFilters, opts: { page?: number; now?: Date } = {}): Promise<ReportData> {
  const f = withDefaultRange(filters, opts.now);
  const bucket = chooseBucket(f.from, f.to);
  return withTenant(orgId, async (tx) => ({
    range: { from: f.from, to: f.to, bucket },
    summary: await invoiceSummary(tx, f),
    billed: await billedTotals(tx, f),
    volume: await invoiceVolume(tx, f, bucket),
    outcomes: await outcomesByCurrency(tx, f),
    byType: await unresolvedByType(tx, f),
    byAge: await unresolvedByAge(tx, f, opts.now),
    failures: await processingFailures(tx, f),
    suppliers: await supplierBreakdown(tx, f, opts.page ?? 1),
  }));
}

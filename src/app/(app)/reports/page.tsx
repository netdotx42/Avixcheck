import Link from "next/link";
import { BarChart3, Download } from "lucide-react";
import { Card, EmptyState, ErrorState, PageHeader, Stat } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { StatusBadge, type Tone } from "@/components/ui/status-badge";
import { withTenant } from "@/db/tenant";
import { isConfigured } from "@/env";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { formatDate, formatMoney } from "@/lib/format";
import { EXPORT_KINDS, EXPORT_LABELS } from "@/modules/exports/definitions";
import { listExports, type ExportRow } from "@/modules/exports/service";
import { parseReportFilters } from "@/modules/reports/filters";
import { reportData, supplierOptions, withDefaultRange } from "@/modules/reports/queries";
import { Amounts, DemoBanner, FailuresCard, OutcomesTable, UnresolvedTable, VolumeChart } from "@/modules/reports/ui";
import { AutoRefresh, ExportForm } from "./export-form";

export const metadata = { title: "Reports" };

type SP = Record<string, string | string[] | undefined>;

function exportStatus(e: ExportRow, now: Date): { tone: Tone; label: string } {
  if (e.status === "ready" && e.expiresAt && e.expiresAt <= now) return { tone: "neutral", label: "Expired" };
  switch (e.status) {
    case "queued": return { tone: "progress", label: "Generating" };
    case "ready": return { tone: "ok", label: "Ready" };
    case "failed": return { tone: "danger", label: "Failed" };
    default: return { tone: "neutral", label: "Expired" };
  }
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await pageContext("report.view");
  const sp = await searchParams;
  const { filters, error } = parseReportFilters(sp);
  const page = parsePage(sp.page);
  const exportsPage = parsePage(sp.exports);
  const range = withDefaultRange(filters);
  const canExport = can(ctx.role, "export.create");

  const [data, suppliers, exportList] = await Promise.all([
    reportData(ctx.orgId, filters, { page }),
    withTenant(ctx.orgId, (tx) => supplierOptions(tx)),
    canExport ? listExports(ctx.orgId, exportsPage) : Promise.resolve({ rows: [], total: 0 }),
  ]);
  const now = new Date();
  const params = { from: range.from, to: range.to, supplier: filters.supplierId };
  const hasData = data.summary.total > 0;
  const exportsHref = (p: number) =>
    `/reports?${new URLSearchParams(Object.entries({ ...params, page: page > 1 ? String(page) : undefined, exports: String(p) }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <>
      <PageHeader title="Reports" description="Invoice volume, unresolved discrepancies, exposure versus realised savings, and processing failures." />
      {ctx.isDemo && <DemoBanner />}

      <Card className="mb-6">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
          <div>
            <label className="label" htmlFor="from">Received from</label>
            <input id="from" name="from" type="date" className="input" defaultValue={range.from} max={range.to} />
          </div>
          <div>
            <label className="label" htmlFor="to">Received to</label>
            <input id="to" name="to" type="date" className="input" defaultValue={range.to} />
          </div>
          <div>
            <label className="label" htmlFor="supplier">Supplier</label>
            <select id="supplier" name="supplier" className="input" defaultValue={filters.supplierId ?? ""}>
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button className="btn btn-primary">Apply</button>
            <Link href="/reports" className="btn btn-secondary">Reset</Link>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted">Dates are the UTC day an invoice was received in AvixCheck. Without a range, the last 90 days are shown.</p>
      </Card>

      {error && <div className="mb-6"><ErrorState title="Those filters aren't valid" body={`${error}. Showing the default range instead.`} action={<Link href="/reports" className="btn btn-secondary">Reset filters</Link>} /></div>}

      {!hasData ? (
        <EmptyState
          icon={BarChart3}
          title="No invoices in this range"
          body="Reports summarise received invoices, unresolved discrepancies, exposure, confirmed corrections and processing failures. Widen the date range or upload invoices to get started."
          action={can(ctx.role, "invoice.upload") ? <Link href="/invoices/upload" className="btn btn-primary">Upload invoices</Link> : undefined}
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Received" value={String(data.summary.total)} hint={`${data.summary.invoices} invoices · ${data.summary.creditNotes} credit notes`} />
            <Stat label="Passed checks" value={String(data.summary.passed)} hint="Not payment approval" />
            <Stat label="With open exceptions" value={String(data.summary.exceptionsOpen)} hint={`${data.summary.needsReview} awaiting extraction or matching review`} />
            <Stat label="Failed or quarantined" value={String(data.summary.failed)} hint={`${data.summary.inProgress} still processing · ${data.summary.rejected} rejected`} />
          </div>

          <VolumeChart points={data.volume} bucket={data.range.bucket} />

          <OutcomesTable outcomes={data.outcomes} />

          <div className="grid gap-4 xl:grid-cols-2">
            <UnresolvedTable title="Unresolved by type" keyHeader="Type" groups={data.byType} emptyText="No unresolved discrepancies for these invoices." linkFor={(k) => `/exceptions?type=${encodeURIComponent(k)}`} />
            <UnresolvedTable title="Unresolved by age" description="Time since the exception was raised." keyHeader="Age" groups={data.byAge} labelFor={(k) => k} emptyText="Nothing waiting for review." />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <h2 className="font-semibold">Billed amounts</h2>
              <p className="mb-3 mt-1 text-sm text-muted">Totals as printed on documents in this range, per currency. Credit notes are shown separately.</p>
              {data.billed.length === 0 ? (
                <p className="text-sm text-muted">No extracted totals yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th>Currency</th><th className="text-right">Invoiced</th><th className="text-right">Credit notes</th></tr></thead>
                    <tbody>
                      {data.billed.map((b) => (
                        <tr key={b.currency}><td className="font-medium">{b.currency}</td><td className="num text-right">{formatMoney(b.invoiced, b.currency)}</td><td className="num text-right">{formatMoney(b.credited, b.currency)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <FailuresCard failures={data.failures} canRecover={can(ctx.role, "jobs.recover")} />
          </div>

          <Card>
            <h2 className="mb-3 font-semibold">By supplier</h2>
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Supplier</th><th className="text-right">Received</th><th className="text-right">Open exceptions</th><th className="text-right">Potential exposure</th><th className="text-right">Realised savings</th></tr></thead>
                <tbody>
                  {data.suppliers.rows.map((s) => (
                    <tr key={s.supplierId ?? "unmatched"}>
                      <td>
                        {s.supplierId ? <Link className="hover:text-focus hover:underline" href={`/reports?${new URLSearchParams({ from: range.from, to: range.to, supplier: s.supplierId })}`}>{s.name}</Link> : <span className="text-muted">{s.name}</span>}
                        {s.code && <div className="text-xs text-muted">{s.code}</div>}
                      </td>
                      <td className="num text-right">{s.invoices}</td>
                      <td className="num text-right">{s.openExceptions}</td>
                      <td className="text-right text-warn"><Amounts list={s.exposure} /></td>
                      <td className="text-right text-ok"><Amounts list={s.realised} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={20} total={data.suppliers.total} basePath="/reports" params={params} />
          </Card>
        </div>
      )}

      <Card className="mt-6">
        <div className="mb-4 flex items-center gap-2">
          <Download aria-hidden className="size-4 text-silver" />
          <h2 className="font-semibold">Exports</h2>
        </div>
        {!canExport ? (
          <p className="text-sm text-muted">Your role can view reports but not export data. Ask an Admin or Reviewer for an export.</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
            <ExportForm
              kinds={EXPORT_KINDS.map((k) => ({ value: k, ...EXPORT_LABELS[k] }))}
              filters={{ from: range.from, to: range.to, supplier: filters.supplierId }}
              disabledReason={isConfigured("storage") ? undefined : "Exports are unavailable until private document storage (S3) is configured. See Setup."}
            />
            <div className="min-w-0">
              <AutoRefresh active={exportList.rows.some((e) => e.status === "queued")} />
              {exportList.total === 0 ? (
                <p className="text-sm text-muted">No exports yet. Exports you and your team create appear here with their status.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="table">
                      <thead><tr><th>Export</th><th>Status</th><th className="text-right">Rows</th><th>Created</th><th>Expires</th><th className="text-right"><span className="sr-only">Download</span></th></tr></thead>
                      <tbody>
                        {exportList.rows.map((e) => {
                          const st = exportStatus(e, now);
                          const f = e.filters as { from?: string; to?: string; supplierId?: string };
                          return (
                            <tr key={e.id}>
                              <td>
                                <div>{EXPORT_LABELS[e.kind as keyof typeof EXPORT_LABELS]?.label ?? e.kind}</div>
                                <div className="num text-xs text-muted">{f.from ?? "…"} → {f.to ?? "…"}{f.supplierId ? " · one supplier" : ""}</div>
                                {e.status === "failed" && e.error && <div className="mt-1 text-xs text-danger">{e.error}</div>}
                              </td>
                              <td><StatusBadge tone={st.tone} label={st.label} /></td>
                              <td className="num text-right">{e.rowCount ?? "—"}</td>
                              <td className="num text-muted">{formatDate(e.createdAt)}</td>
                              <td className="num text-muted">{formatDate(e.expiresAt)}</td>
                              <td className="text-right">
                                {st.label === "Ready" && <a className="btn btn-secondary py-1" href={`/api/exports/${e.id}/download`}>Download</a>}
                                {e.status === "failed" && can(ctx.role, "jobs.recover") && <Link className="text-xs text-focus hover:underline" href="/settings">Retry in Settings</Link>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <nav aria-label="Export pages" className="mt-4 flex items-center justify-between text-sm text-muted">
                    <span className="num">{(exportsPage - 1) * 10 + 1}–{Math.min(exportsPage * 10, exportList.total)} of {exportList.total}</span>
                    <div className="flex gap-2">
                      {exportsPage > 1 && <Link className="btn btn-secondary" href={exportsHref(exportsPage - 1)}>Newer</Link>}
                      {exportsPage * 10 < exportList.total && <Link className="btn btn-secondary" href={exportsHref(exportsPage + 1)}>Older</Link>}
                    </div>
                  </nav>
                </>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

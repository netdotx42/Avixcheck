import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { KIND_FILTERS, listExceptions, listFilterOptions, STATUS_FILTERS, TYPE_FILTERS, type StatusFilter } from "@/modules/exceptions/queries";
import { STATUS_LABEL } from "@/modules/exceptions/rules";
import { TYPE_LABEL } from "@/modules/exceptions/display";
import { ExceptionTable } from "./exception-table";

export const metadata = { title: "Exceptions" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length <= 200 ? s : undefined;
}

export default async function ExceptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await pageContext("exception.view");
  const sp = await searchParams;
  const statusRaw = one(sp.status);
  const filters = {
    q: one(sp.q),
    status: (STATUS_FILTERS as readonly string[]).includes(statusRaw ?? "") ? (statusRaw as StatusFilter) : "unresolved",
    type: one(sp.type),
    assignee: one(sp.assignee),
    supplierId: one(sp.supplier),
    page: parsePage(sp.page),
  } as const;
  const [{ rows, total, page, pageSize }, options] = await Promise.all([listExceptions(ctx.orgId, ctx.user.id, filters), listFilterOptions(ctx.orgId)]);
  const filtered = !!(filters.q || filters.type || filters.assignee || filters.supplierId || filters.status !== "unresolved");
  const params = { q: filters.q, status: filters.status, type: filters.type, assignee: filters.assignee, supplier: filters.supplierId };

  return (
    <>
      <PageHeader title="Exceptions" description="Discrepancies and records that need a person. Amounts shown are potential exposure until a correction is confirmed." />

      <form method="get" className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]" role="search">
        <div>
          <label className="label" htmlFor="f-q">Search</label>
          <input id="f-q" name="q" defaultValue={filters.q} placeholder="Title, invoice no., supplier, PO" className="input" maxLength={100} />
        </div>
        <div>
          <label className="label" htmlFor="f-status">Status</label>
          <select id="f-status" name="status" defaultValue={filters.status} className="input">
            <option value="unresolved">Unresolved</option>
            <option value="all">All</option>
            {STATUS_FILTERS.filter((s) => s !== "unresolved" && s !== "all").map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-type">Type</label>
          <select id="f-type" name="type" defaultValue={filters.type ?? ""} className="input">
            <option value="">All types</option>
            <optgroup label="Discrepancies">
              {TYPE_FILTERS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
            </optgroup>
            <optgroup label="Review and failures">
              {KIND_FILTERS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
            </optgroup>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-assignee">Assignee</label>
          <select id="f-assignee" name="assignee" defaultValue={filters.assignee ?? ""} className="input">
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
            {options.assignees.map((a) => <option key={a.userId} value={a.userId}>{a.name ?? a.email}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-supplier">Supplier</label>
          <select id="f-supplier" name="supplier" defaultValue={filters.supplierId ?? ""} className="input">
            <option value="">All suppliers</option>
            {options.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button className="btn btn-primary">Apply</button>
          {filtered && <Link href="/exceptions" className="btn btn-secondary">Clear</Link>}
        </div>
      </form>

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState icon={ShieldAlert} title="No matching exceptions" body="Nothing matches these filters. Try a different status or clear the filters." action={<Link href="/exceptions" className="btn btn-secondary">Clear filters</Link>} />
        ) : (
          <EmptyState
            icon={ShieldAlert}
            title="Nothing needs review"
            body="When checks find a discrepancy, or extraction or matching is uncertain, it appears here to be assigned and decided."
            action={<Link href="/exceptions?status=all" className="btn btn-secondary">Show decided exceptions</Link>}
          />
        )
      ) : (
        <>
          <ExceptionTable
            rows={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
            assignees={options.assignees.map((a) => ({ userId: a.userId, label: a.name ?? a.email }))}
            canAssign={can(ctx.role, "exception.assign")}
          />
          <Pagination page={page} pageSize={pageSize} total={total} basePath="/exceptions" params={params} />
        </>
      )}
    </>
  );
}

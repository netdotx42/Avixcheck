import Link from "next/link";
import { FileText, SearchX, Upload } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { formatDate, formatMoney } from "@/lib/format";
import { listInvoices, PAGE_SIZE, STATUS_FILTERS, STATUS_META } from "@/modules/documents/queries";

export const metadata = { title: "Invoices" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  const ctx = await pageContext("invoice.view");
  const sp = await searchParams;
  const q = one(sp.q)?.slice(0, 100) ?? "";
  const filter = one(sp.status);
  const status = filter && STATUS_FILTERS[filter] ? filter : undefined;
  const page = parsePage(sp.page);
  const { rows, total } = await listInvoices(ctx.orgId, { q, filter: status, page });
  const canUpload = can(ctx.role, "invoice.upload");
  const filtered = !!q || !!status;

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Supplier invoices and credit notes, from upload through scanning, extraction and checks."
        actions={canUpload ? <Link href="/invoices/upload" className="btn btn-primary"><Upload aria-hidden className="size-4" />Upload invoices</Link> : undefined}
      />

      <form role="search" className="mb-4 grid gap-3 sm:grid-cols-[1fr_14rem_auto]" action="/invoices">
        <div>
          <label htmlFor="q" className="sr-only">Search invoices</label>
          <input id="q" name="q" defaultValue={q} placeholder="Search invoice number, supplier, PO or file name" className="input" />
        </div>
        <div>
          <label htmlFor="status" className="sr-only">Status</label>
          <select id="status" name="status" defaultValue={status ?? ""} className="input">
            <option value="">All statuses</option>
            {Object.entries(STATUS_FILTERS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary">Filter</button>
          {filtered && <Link href="/invoices" className="btn btn-secondary">Clear</Link>}
        </div>
      </form>

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState icon={SearchX} title="No invoices match" body="Try a different search term or status filter." action={<Link href="/invoices" className="btn btn-secondary">Clear filters</Link>} />
        ) : (
          <EmptyState
            icon={FileText}
            title="No invoices yet"
            body="Upload supplier PDF invoices to scan, extract and check them against your purchase orders and agreements."
            action={canUpload ? <Link href="/invoices/upload" className="btn btn-primary">Upload invoices</Link> : undefined}
          />
        )
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Supplier</th>
                <th>Date</th>
                <th className="text-right">Total</th>
                <th>Status</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = STATUS_META[r.status];
                return (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/invoices/${r.id}`} className="font-medium text-text hover:text-focus hover:underline">
                        {r.invoiceNumber ?? <span className="text-muted">Not extracted yet</span>}
                      </Link>
                      {r.kind === "credit_note" && <span className="ml-2 text-xs text-info">Credit note</span>}
                      <div className="max-w-56 truncate text-xs text-muted" title={r.originalName}>{r.originalName}</div>
                    </td>
                    <td className="max-w-56 truncate">{r.supplierName ?? <span className="text-muted">—</span>}</td>
                    <td className="num text-muted">{formatDate(r.invoiceDate)}</td>
                    <td className="num text-right">{formatMoney(r.total, r.currency)}</td>
                    <td><span title={r.failureReason ?? meta.hint}><StatusBadge tone={meta.tone} label={meta.label} /></span></td>
                    <td className="num text-muted">{formatDate(r.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/invoices" params={{ q: q || undefined, status }} />
    </>
  );
}

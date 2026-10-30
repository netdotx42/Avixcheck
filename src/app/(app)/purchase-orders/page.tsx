import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { ImportLinks } from "@/components/reference/import-links";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/db/tenant";
import { formatDate, formatMoney } from "@/lib/format";
import { listPurchaseOrders, PAGE_SIZE, supplierOptions } from "@/modules/imports/queries";
import { param, pick, PO_STATUS, UUID_RE } from "@/modules/imports/labels";

export const metadata = { title: "Purchase Orders" };

const STATUSES = ["open", "closed", "cancelled"] as const;

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await pageContext("reference.view");
  const sp = await searchParams;
  const q = param(sp.q);
  const status = pick(param(sp.status), STATUSES);
  const supplierParam = param(sp.supplier);
  const supplierId = supplierParam && UUID_RE.test(supplierParam) ? supplierParam : undefined;
  const page = parsePage(sp.page);
  const canImport = can(ctx.role, "reference.import");
  const { list, options } = await withTenant(ctx.orgId, async (tx) => ({
    list: await listPurchaseOrders(tx, { q, status, supplierId, page }),
    options: await supplierOptions(tx),
  }));
  const filtered = !!(q || status || supplierId);

  return (
    <>
      <PageHeader
        title="Purchase Orders"
        description="Ordered, billed and remaining values per PO. Billed amounts come from invoices that passed matching; credit notes reduce them."
        actions={<ImportLinks kinds={["purchase_orders", "receipts"]} canImport={canImport} />}
      />
      <form method="get" role="search" className="mb-4 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="q">Search</label>
        <input id="q" name="q" defaultValue={q} placeholder="PO number or supplier…" className="input w-64 max-w-full py-1.5" />
        <label className="sr-only" htmlFor="status">Status</label>
        <select id="status" name="status" defaultValue={status ?? ""} className="input w-auto py-1.5">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{PO_STATUS[s]!.label}</option>)}
        </select>
        <label className="sr-only" htmlFor="supplier">Supplier</label>
        <select id="supplier" name="supplier" defaultValue={supplierId ?? ""} className="input w-auto max-w-56 py-1.5">
          <option value="">All suppliers</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.code} · {o.name}</option>)}
        </select>
        <button className="btn btn-secondary py-1.5">Search</button>
      </form>
      {list.rows.length === 0 ? (
        filtered ? (
          <EmptyState icon={ShoppingCart} title="No purchase orders match" body="Try a different search or clear the filters." action={<Link className="btn btn-secondary" href="/purchase-orders">Clear filters</Link>} />
        ) : (
          <EmptyState icon={ShoppingCart} title="No purchase orders yet" body="Import purchase orders and their lines from the CSV template. Re-importing a changed PO amends it and keeps the earlier version." action={canImport ? <Link className="btn btn-primary" href="/imports?kind=purchase_orders">Import purchase orders</Link> : undefined} />
        )
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>PO</th><th>Supplier</th><th>Issued</th><th className="text-right">Lines</th><th className="text-right">Ordered</th><th className="text-right">Billed</th><th className="text-right">Remaining</th><th>Status</th></tr>
            </thead>
            <tbody>
              {list.rows.map((p) => (
                <tr key={p.id}>
                  <td><Link className="text-focus hover:underline" href={`/purchase-orders/${p.id}`}>{p.poNumber}</Link>{p.version > 1 && <div className="text-xs text-muted">v{p.version}</div>}</td>
                  <td><div>{p.supplierName}</div><div className="font-mono text-xs text-muted">{p.supplierCode}</div></td>
                  <td className="num text-muted">{formatDate(p.issuedOn)}</td>
                  <td className="num text-right">{p.lines}</td>
                  <td className="num whitespace-nowrap text-right">{formatMoney(p.ordered, p.currency)}</td>
                  <td className="num whitespace-nowrap text-right">{formatMoney(p.billed, p.currency)}</td>
                  <td className={`num whitespace-nowrap text-right ${p.remaining.startsWith("-") ? "text-danger" : ""}`}>{formatMoney(p.remaining, p.currency)}</td>
                  <td><StatusBadge {...PO_STATUS[p.status]!} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={list.total} basePath="/purchase-orders" params={{ q, status, supplier: supplierId }} />
    </>
  );
}

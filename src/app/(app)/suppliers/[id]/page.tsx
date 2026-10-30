import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";
import { formatDate, formatMoney } from "@/lib/format";
import { agreementState, getSupplier } from "@/modules/imports/queries";
import { AGREEMENT_STATE, formatQty, PO_STATUS, UUID_RE } from "@/modules/imports/labels";

export const metadata = { title: "Supplier" };

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await pageContext("reference.view");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const data = await withTenant(ctx.orgId, (tx) => getSupplier(tx, id));
  if (!data) notFound();
  const { supplier: s, agreements, charges, pos } = data;

  return (
    <>
      <PageHeader title={s.name} description={`Supplier ${s.code} · version ${s.version} · updated ${formatDate(s.updatedAt)}`} actions={<Link className="btn btn-secondary" href="/suppliers">All suppliers</Link>} />
      <div className="space-y-6">
        <Card>
          <dl className="grid gap-4 text-sm sm:grid-cols-4">
            <div><dt className="text-muted">Status</dt><dd className="mt-1">{s.active ? <StatusBadge tone="ok" label="Active" /> : <StatusBadge tone="neutral" label="Inactive" />}</dd></div>
            <div><dt className="text-muted">Tax ID</dt><dd className="mt-1">{s.taxId ?? "—"}</dd></div>
            <div><dt className="text-muted">Default currency</dt><dd className="mt-1">{s.currency ?? "—"}</dd></div>
            <div><dt className="text-muted">Names on invoices</dt><dd className="mt-1">{s.aliases.length ? s.aliases.join(", ") : "—"}</dd></div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">Price agreements</h2>
          <p className="mb-4 text-sm text-muted">All versions, including superseded ones that earlier checks may have used.</p>
          {agreements.length === 0 ? <p className="text-sm text-muted">No agreements for this supplier.</p> : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Agreement</th><th>SKU</th><th>Unit</th><th className="text-right">Unit price</th><th className="text-right">Discount</th><th className="text-right">Min qty</th><th>Valid</th><th>Version</th><th>State</th></tr></thead>
                <tbody>
                  {agreements.map((a) => (
                    <tr key={a.id} className={a.supersededAt ? "text-muted" : ""}>
                      <td>{a.agreementRef}</td>
                      <td>{a.sku}{a.description && <div className="text-xs text-muted">{a.description}</div>}</td>
                      <td>{a.unit}</td>
                      <td className="num whitespace-nowrap text-right">{a.currency} {formatQty(a.unitPrice)}</td>
                      <td className="num text-right">{formatQty(a.discountPct)}%</td>
                      <td className="num text-right">{formatQty(a.minQuantity)}</td>
                      <td className="num whitespace-nowrap">{formatDate(a.validFrom)} – {a.validTo ? formatDate(a.validTo) : "open"}</td>
                      <td className="num">v{a.version}{a.supersededAt && <div className="text-xs">replaced {formatDate(a.supersededAt)}</div>}</td>
                      <td><StatusBadge {...AGREEMENT_STATE[agreementState(a)]} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-4 font-semibold">Approved charges</h2>
          {charges.length === 0 ? <p className="text-sm text-muted">No approved charges. Any freight or other charge on this supplier&apos;s invoices will be flagged.</p> : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Charge type</th><th className="text-right">Maximum</th><th>Valid</th><th>Version</th><th>State</th></tr></thead>
                <tbody>
                  {charges.map((c) => (
                    <tr key={c.id} className={c.supersededAt ? "text-muted" : ""}>
                      <td>{c.chargeType}</td>
                      <td className="num text-right">{c.maxAmount ? formatMoney(c.maxAmount, c.currency) : `No cap (${c.currency})`}</td>
                      <td className="num whitespace-nowrap">{formatDate(c.validFrom)} – {c.validTo ? formatDate(c.validTo) : "open"}</td>
                      <td className="num">v{c.version}</td>
                      <td><StatusBadge {...AGREEMENT_STATE[agreementState(c)]} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Recent purchase orders</h2>
            <Link className="text-sm text-focus hover:underline" href={`/purchase-orders?supplier=${s.id}`}>All POs for {s.code}</Link>
          </div>
          {pos.length === 0 ? <p className="text-sm text-muted">No purchase orders.</p> : (
            <ul className="divide-y divide-border/60 text-sm">
              {pos.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <Link className="text-focus hover:underline" href={`/purchase-orders/${p.id}`}>{p.poNumber}</Link>
                  <span className="flex items-center gap-3 text-muted"><span className="num">{formatDate(p.issuedOn)}</span><StatusBadge {...PO_STATUS[p.status]!} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

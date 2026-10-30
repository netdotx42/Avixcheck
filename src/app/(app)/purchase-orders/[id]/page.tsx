import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Card, PageHeader, Stat } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { withTenant } from "@/db/tenant";
import { formatDate, formatMoney } from "@/lib/format";
import { getPurchaseOrder } from "@/modules/imports/queries";
import { formatQty, PO_STATUS, UUID_RE } from "@/modules/imports/labels";

export const metadata = { title: "Purchase order" };

type SnapLine = { lineNo: number; sku: string | null; description: string; quantity: string; unit: string; unitPrice: string; cancelled: boolean };

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await pageContext("reference.view");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const data = await withTenant(ctx.orgId, (tx) => getPurchaseOrder(tx, id));
  if (!data) notFound();
  const { po, supplierCode, supplierName, lines, totals, revisions } = data;
  const cur = po.currency;
  const over = totals.remaining.startsWith("-");

  return (
    <>
      <PageHeader
        title={po.poNumber}
        description={`${supplierName} (${supplierCode}) · issued ${formatDate(po.issuedOn)} · version ${po.version}`}
        actions={<><StatusBadge {...PO_STATUS[po.status]!} /><Link className="btn btn-secondary" href="/purchase-orders">All purchase orders</Link></>}
      />
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Ordered" value={formatMoney(totals.ordered, cur)} hint={`${data.activeLineCount} active line${data.activeLineCount === 1 ? "" : "s"}`} />
          <Stat label="Billed" value={formatMoney(totals.billed, cur)} hint="Invoices net of credit notes" />
          <Stat label="Remaining" value={formatMoney(totals.remaining, cur)} hint={over ? "Billed above the PO value" : "Ordered minus billed"} tone={over ? "exposure" : "default"} />
        </div>

        <Card>
          <h2 className="mb-4 font-semibold">Lines</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th><th>Item</th><th>Unit</th><th className="text-right">Unit price</th>
                  <th className="text-right">Ordered qty</th><th className="text-right">Billed qty</th><th className="text-right">Remaining qty</th>
                  <th className="text-right">Received</th><th className="text-right">Remaining value</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const overQty = l.remainingQty.startsWith("-");
                  return (
                    <tr key={l.line.id} className={l.line.cancelled ? "text-muted" : ""}>
                      <td className="num">{l.line.lineNo}</td>
                      <td><div>{l.line.description}</div>{l.line.sku && <div className="font-mono text-xs text-muted">{l.line.sku}</div>}</td>
                      <td>{l.line.unit}</td>
                      <td className="num text-right">{formatQty(l.line.unitPrice)}</td>
                      <td className="num text-right">{formatQty(l.line.quantity)}</td>
                      <td className="num text-right">{formatQty(l.billedQty)}{l.invoices > 0 && <div className="text-xs text-muted">{l.invoices} invoice{l.invoices > 1 ? "s" : ""}</div>}</td>
                      <td className={`num text-right ${overQty ? "text-danger" : ""}`}>{overQty && <AlertTriangle aria-label="Over-billed" className="mr-1 inline size-3.5" />}{formatQty(l.remainingQty)}</td>
                      <td className="num text-right">{l.receipts.length ? formatQty(l.receivedQty) : <span className="text-muted" title="No receipt data; receipt checks do not run for this line">—</span>}</td>
                      <td className="num whitespace-nowrap text-right">{formatMoney(l.remainingAmount, cur)}</td>
                      <td>{l.line.cancelled ? <StatusBadge tone="neutral" label="Cancelled" /> : <StatusBadge tone="ok" label="Active" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lines.some((l) => l.receipts.length) && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-muted hover:text-text">Goods receipts</summary>
              <table className="table mt-2">
                <thead><tr><th>Receipt</th><th>Line</th><th className="text-right">Quantity</th><th>Received</th></tr></thead>
                <tbody>
                  {lines.flatMap((l) => l.receipts.map((r) => (
                    <tr key={r.id}><td>{r.receiptRef}</td><td className="num">{l.line.lineNo}</td><td className="num text-right">{formatQty(r.quantity)}</td><td className="num">{formatDate(r.receivedOn)}</td></tr>
                  )))}
                </tbody>
              </table>
            </details>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">Versions</h2>
          <p className="mb-4 text-sm text-muted">Each amendment keeps a snapshot of the PO as it was before the change. Checks record which version they used.</p>
          {revisions.length === 0 ? (
            <p className="text-sm text-muted">Version 1 is the only version; this PO has not been amended.</p>
          ) : (
            <ul className="space-y-3">
              <li className="text-sm"><StatusBadge tone="ok" label={`v${po.version} current`} /> <span className="ml-2 text-muted">updated {formatDate(po.updatedAt)}</span></li>
              {revisions.map((r) => {
                const snap = r.snapshot as { lines?: SnapLine[] };
                return (
                  <li key={r.id} className="rounded-lg border border-border p-3 text-sm">
                    <details>
                      <summary className="cursor-pointer">
                        <span className="font-medium">v{r.version}</span>
                        <span className="ml-2 text-muted">replaced {formatDate(r.createdAt)}{r.by ? ` by ${r.by}` : ""}</span>
                        {r.reason && <div className="mt-1 text-xs text-muted">{r.reason}</div>}
                      </summary>
                      <div className="mt-3 overflow-x-auto">
                        <table className="table">
                          <thead><tr><th>#</th><th>Item</th><th>Unit</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th>Status</th></tr></thead>
                          <tbody>
                            {(snap.lines ?? []).sort((a, b) => a.lineNo - b.lineNo).map((l) => (
                              <tr key={l.lineNo}>
                                <td className="num">{l.lineNo}</td><td>{l.description}</td><td>{l.unit}</td>
                                <td className="num text-right">{formatQty(l.quantity)}</td><td className="num text-right">{formatQty(l.unitPrice)}</td>
                                <td>{l.cancelled ? "Cancelled" : "Active"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

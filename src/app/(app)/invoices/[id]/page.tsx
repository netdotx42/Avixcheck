import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, FileWarning, ShieldAlert } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { formatDate, formatMoney } from "@/lib/format";
import { retryInvoiceProcessingAction } from "@/app/actions/invoices";
import { getInvoiceDetail, STATUS_META } from "@/modules/documents/queries";
import { CORRECTABLE_STATUSES } from "@/modules/documents/correction";
import type { ExtractionRecord } from "@/modules/extraction/jobs";
import { InvoiceEditor } from "./editor";

export const metadata = { title: "Invoice" };

const pct = (v: string | null) => (v === null ? "—" : `${(Number(v) * 100).toFixed(0)}%`);
const EXCEPTION_KIND = { discrepancy: "Discrepancy", extraction_review: "Extraction review", matching_review: "Matching review", processing_failure: "Processing failure" } as const;

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await pageContext("invoice.view");
  const { id } = await params;
  const d = await getInvoiceDetail(ctx.orgId, id);
  if (!d) notFound();
  const { invoice: inv, doc, lines } = d;
  const meta = STATUS_META[inv.status];
  const record = inv.extractionRaw as ExtractionRecord | null;
  const canPreview = can(ctx.role, "document.view") && doc.scanStatus === "clean" && !doc.deletedAt;
  const canEdit = can(ctx.role, "invoice.edit") && (CORRECTABLE_STATUSES as readonly string[]).includes(inv.status);
  const canRecover = can(ctx.role, "jobs.recover") && inv.status !== "quarantined" && d.failedJobs.some((j) => j.type === "document.scan" || j.type === "invoice.extract");
  const title = inv.invoiceNumber ? `${inv.kind === "credit_note" ? "Credit note" : "Invoice"} ${inv.invoiceNumber}` : doc.originalName;

  return (
    <>
      <PageHeader
        title={title}
        description={[d.supplierName ?? inv.supplierNameRaw, inv.invoiceDate ? formatDate(inv.invoiceDate) : null].filter(Boolean).join(" · ") || "Awaiting extraction"}
        actions={<><StatusBadge tone={meta.tone} label={meta.label} /><Link href="/invoices" className="btn btn-secondary">All invoices</Link></>}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-label="Original document" className="card flex min-h-[32rem] flex-col overflow-hidden xl:sticky xl:top-6 xl:h-[calc(100dvh-8rem)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
            <span className="truncate text-muted" title={doc.originalName}>{doc.originalName}</span>
            {canPreview && <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-focus hover:underline">Open<ExternalLink aria-hidden className="size-3.5" /></a>}
          </div>
          {canPreview ? (
            <iframe title={`Original document: ${doc.originalName}`} src={`/api/documents/${doc.id}/file`} className="w-full flex-1 bg-white" referrerPolicy="no-referrer" />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-sm text-muted">
              {doc.scanStatus === "infected" ? <ShieldAlert aria-hidden className="mb-3 size-8 text-danger" /> : <FileWarning aria-hidden className="mb-3 size-8 text-silver" />}
              <p className="max-w-sm">
                {doc.deletedAt
                  ? "Document removed under retention."
                  : doc.scanStatus === "infected"
                    ? "Malware was detected. The file is quarantined and is never shown or processed."
                    : doc.scanStatus === "clean"
                      ? "Your role cannot view documents."
                      : doc.scanDetail ?? "The document is shown once it passes malware scanning."}
              </p>
            </div>
          )}
        </section>

        <div className="space-y-6">
          <Card>
            <h2 className="font-semibold">Processing</h2>
            <p className="mt-1 text-sm text-muted">{meta.hint}</p>
            {inv.failureReason && <p role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{inv.failureReason}</p>}
            {d.failedJobs.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {d.failedJobs.map((j) => (
                  <li key={j.id} className="text-muted"><StatusBadge tone="danger" label={j.type} /> <span className="num">{j.attempts}/{j.maxAttempts} attempts</span> · {j.lastError}</li>
                ))}
              </ul>
            )}
            {canRecover && (
              <form action={retryInvoiceProcessingAction} className="mt-3">
                <input type="hidden" name="invoiceId" value={inv.id} />
                <button className="btn btn-secondary">Retry processing</button>
              </form>
            )}
            {d.openExceptions.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium">Open exceptions</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {d.openExceptions.map((e) => (
                    <li key={e.id}>
                      <Link href={`/exceptions/${e.id}`} className="hover:underline"><StatusBadge tone={e.kind === "processing_failure" ? "danger" : "warn"} label={EXCEPTION_KIND[e.kind]} /> {e.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <div><dt className="text-muted">Uploaded</dt><dd className="num">{formatDate(inv.createdAt)}</dd></div>
              <div><dt className="text-muted">Malware scan</dt><dd>{doc.scanStatus === "clean" ? "Clean" : doc.scanStatus === "infected" ? "Infected" : doc.scanStatus === "error" ? "Error" : "Not scanned"}</dd></div>
              <div><dt className="text-muted">Revision</dt><dd className="num">{inv.revision}</dd></div>
              <div><dt className="text-muted">Extraction confidence</dt><dd className="num">{pct(inv.extractionConfidence)}</dd></div>
              <div><dt className="text-muted">Model</dt><dd className="truncate">{inv.extractionModel ?? "—"}</dd></div>
              <div><dt className="text-muted">Total</dt><dd className="num">{formatMoney(inv.total, inv.currency)}</dd></div>
            </dl>
            {record && (record.issues.length > 0 || record.warnings.length > 0) && (
              <div className="mt-4 rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
                <p className="font-medium text-warn">Why this needs review</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                  {record.issues.map((i, n) => <li key={`i${n}`}>{i}</li>)}
                  {record.warnings.map((w, n) => <li key={`w${n}`}>Extractor warning: {w}</li>)}
                </ul>
                <p className="mt-2 text-xs text-muted">Values come from the document and are untrusted until checked.</p>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-1 font-semibold">Extracted values</h2>
            <p className="mb-4 text-sm text-muted">
              {canEdit ? "Correct anything that does not match the document. Saving re-runs matching and checks against the new values." : "Read-only."}
            </p>
            {lines.length === 0 && !inv.invoiceNumber && !canEdit ? (
              <p className="text-sm text-muted">Nothing has been extracted yet.</p>
            ) : (
              <InvoiceEditor
                key={inv.revision}
                editable={canEdit}
                inReview={inv.status === "extraction_review"}
                invoiceId={inv.id}
                revision={inv.revision}
                header={{
                  kind: inv.kind,
                  supplierNameRaw: inv.supplierNameRaw,
                  supplierTaxIdRaw: inv.supplierTaxIdRaw,
                  invoiceNumber: inv.invoiceNumber,
                  invoiceDate: inv.invoiceDate,
                  dueDate: inv.dueDate,
                  currency: inv.currency,
                  poNumberRaw: inv.poNumberRaw,
                  creditsInvoiceNumberRaw: inv.creditsInvoiceNumberRaw,
                  subtotal: inv.subtotal,
                  taxTotal: inv.taxTotal,
                  total: inv.total,
                }}
                lines={lines.map((l) => ({
                  id: l.id,
                  lineNo: l.lineNo,
                  lineType: l.lineType,
                  chargeType: l.chargeType,
                  sku: l.sku,
                  description: l.description,
                  quantity: l.quantity,
                  unit: l.unit,
                  unitPrice: l.unitPrice,
                  amount: l.amount,
                  taxRate: l.taxRate,
                  poLineRef: l.poLineRef,
                  extractionConfidence: l.extractionConfidence,
                  manuallyCorrected: l.manuallyCorrected,
                }))}
              />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

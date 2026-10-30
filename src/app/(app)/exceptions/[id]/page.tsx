import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileWarning } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { isConfigured } from "@/env";
import { signedGetUrl } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { formatDate, formatMoney } from "@/lib/format";
import { getExceptionDetail, listFilterOptions, type ExceptionDetail } from "@/modules/exceptions/queries";
import { decisionsFor, hasExposure, isDecidable, KIND_LABEL, permissionFor, STATUS_LABEL } from "@/modules/exceptions/rules";
import { HISTORY_LABEL, SEVERITY_TONE, STATUS_TONE, typeLabel } from "@/modules/exceptions/display";
import { AssignForm, ConfirmCorrectionForm, DecisionForm, StartReviewForm } from "./review-forms";

export const metadata = { title: "Exception" };

async function previewUrl(orgId: string, d: ExceptionDetail): Promise<{ url: string } | { reason: string }> {
  const doc = d.document;
  if (doc.deletedAt) return { reason: "The original document was deleted under the retention policy." };
  if (doc.scanStatus !== "clean") {
    return { reason: doc.scanStatus === "infected" ? "The document failed malware scanning and is quarantined." : "The document has not passed malware scanning yet, so it cannot be previewed." };
  }
  if (!isConfigured("storage")) return { reason: "Document storage is not configured. Set the S3 variables to enable previews." };
  try {
    return { url: await signedGetUrl(orgId, doc.storageKey, { inline: true, filename: doc.originalName }) };
  } catch (e) {
    logger.error({ err: e, documentId: doc.id }, "exception preview: signing failed");
    return { reason: "The preview link could not be created. Try again shortly." };
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

export default async function ExceptionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await pageContext("exception.view");
  const { id } = await params;
  const d = await getExceptionDetail(ctx.orgId, id);
  if (!d) notFound();
  const [preview, options] = await Promise.all([
    can(ctx.role, "document.view") ? previewUrl(ctx.orgId, d) : Promise.resolve({ reason: "You don't have permission to view documents." }),
    listFilterOptions(ctx.orgId),
  ]);
  const currency = d.d?.currency ?? d.invoice.currency;
  const decidable = isDecidable(d.status);
  const amount = d.d?.amount ?? null;
  const decisions = decisionsFor(d.kind).map((decision) => ({
    decision,
    allowed: can(ctx.role, permissionFor(decision, { kind: d.kind, amount })),
  }));
  const exposure = d.kind === "discrepancy" && hasExposure(amount);

  return (
    <>
      <Link href="/exceptions" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" /> Exceptions
      </Link>
      <PageHeader title={d.e.title} description={`${KIND_LABEL[d.kind]} · ${typeLabel(d.d?.type, d.kind)} · raised ${formatDate(d.e.createdAt)}`} actions={<StatusBadge tone={STATUS_TONE[d.status]} label={STATUS_LABEL[d.status]} />} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="flex min-h-[32rem] flex-col p-0">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="font-semibold">Original document</h2>
            <Link href={`/invoices/${d.invoice.id}`} className="text-sm text-focus hover:underline">Open invoice</Link>
          </div>
          {"url" in preview ? (
            <iframe src={preview.url} title={`Invoice ${d.invoice.invoiceNumber ?? ""} PDF`} className="min-h-[32rem] w-full flex-1 rounded-b-[var(--radius-card)] bg-white" />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted">
              <FileWarning aria-hidden className="size-6 text-warn" />
              {preview.reason}
            </div>
          )}
        </Card>

        <div className="space-y-6">
          {d.d ? (
            <Card>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="font-semibold">Expected vs actual</h2>
                <StatusBadge tone={SEVERITY_TONE[d.d.severity] ?? "neutral"} label={`Severity: ${d.d.severity}`} />
              </div>
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                <Field label="Expected"><span className="num">{d.d.expectedValue ?? "—"}</span></Field>
                <Field label="Actual"><span className="num">{d.d.actualValue ?? "—"}</span></Field>
                <Field label="Potential exposure"><span className="num text-warn">{d.d.amount ? formatMoney(d.d.amount, currency) : "Not quantified"}</span></Field>
              </dl>
              <p className="mt-4 whitespace-pre-line text-sm">{d.d.explanation}</p>
              {d.e.confirmedCorrectionAmount && (
                <p className="mt-3 rounded-md border border-ok/40 bg-ok/10 p-3 text-sm">
                  Realised saving: <span className="num font-semibold text-ok">{formatMoney(d.e.confirmedCorrectionAmount, currency)}</span> confirmed by {d.e.confirmedCorrectionRef}
                </p>
              )}
            </Card>
          ) : (
            <Card>
              <h2 className="mb-2 font-semibold">What needs review</h2>
              <p className="text-sm text-muted">
                {d.kind === "processing_failure"
                  ? `Processing failed${d.invoice.failureReason ? `: ${d.invoice.failureReason}` : "."} Recover the job from Settings or reject the invoice.`
                  : "The automated result was uncertain. Correct the invoice data on the invoice page, which re-runs matching and checks, or reject the invoice. Dismissing this never passes the invoice."}
              </p>
            </Card>
          )}

          <Card>
            <h2 className="mb-4 font-semibold">Invoice and references</h2>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <Field label="Supplier">{d.supplierName ?? d.invoice.supplierNameRaw ?? "Unmatched"}{d.supplierCode && <span className="text-muted"> ({d.supplierCode})</span>}</Field>
              <Field label="Invoice">{d.invoice.invoiceNumber ?? "—"} <span className="text-muted">({d.invoice.kind === "credit_note" ? "credit note" : "invoice"})</span></Field>
              <Field label="Invoice date"><span className="num">{formatDate(d.invoice.invoiceDate)}</span></Field>
              <Field label="Total"><span className="num">{formatMoney(d.invoice.total, d.invoice.currency)}</span></Field>
              <Field label="Invoice status">{d.invoice.status.replace(/_/g, " ")}</Field>
              <Field label="PO">{d.poLine ? <Link className="text-focus hover:underline" href={`/purchase-orders/${d.poLine.poId}`}>{d.poLine.poNumber} v{d.poLine.poVersion}</Link> : (d.invoice.poNumberRaw ?? "—")}</Field>
            </dl>
            {d.line && (
              <div className="mt-5 overflow-x-auto">
                <table className="table">
                  <thead><tr><th></th><th>Line</th><th className="text-right">Qty</th><th>Unit</th><th className="text-right">Unit price</th><th className="text-right">Amount</th></tr></thead>
                  <tbody>
                    <tr>
                      <td className="text-muted">Invoice</td>
                      <td>{d.line.lineNo}. {d.line.description ?? d.line.sku ?? ""}{d.line.manuallyCorrected && <span className="ml-1 text-xs text-info">(corrected)</span>}</td>
                      <td className="num text-right">{d.line.quantity ?? "—"}</td>
                      <td>{d.line.unit ?? "—"}</td>
                      <td className="num text-right">{d.line.unitPrice ?? "—"}</td>
                      <td className="num text-right">{formatMoney(d.line.amount, d.invoice.currency)}</td>
                    </tr>
                    {d.poLine && (
                      <tr>
                        <td className="text-muted">PO line</td>
                        <td>{d.poLine.l.lineNo}. {d.poLine.l.description}{d.poLine.l.cancelled && <span className="ml-1 text-xs text-danger">(cancelled)</span>}</td>
                        <td className="num text-right">{d.poLine.l.quantity}</td>
                        <td>{d.poLine.l.unit}</td>
                        <td className="num text-right">{d.poLine.l.unitPrice}</td>
                        <td></td>
                      </tr>
                    )}
                    {d.agreement && (
                      <tr>
                        <td className="text-muted">Agreement</td>
                        <td>{d.agreement.agreementRef} v{d.agreement.version} <span className="text-xs text-muted">({formatDate(d.agreement.validFrom)} – {d.agreement.validTo ? formatDate(d.agreement.validTo) : "open"}{d.agreement.supersededAt ? ", superseded" : ""})</span></td>
                        <td className="num text-right">{d.agreement.minQuantity ? `min ${d.agreement.minQuantity}` : ""}</td>
                        <td>{d.agreement.unit}</td>
                        <td className="num text-right">{d.agreement.unitPrice}{d.agreement.discountPct !== "0.0000" && <span className="text-xs text-muted"> −{d.agreement.discountPct}%</span>}</td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {d.receipts.length > 0 && (
              <p className="mt-3 text-sm text-muted">
                Receipts: {d.receipts.map((r) => `${r.receiptRef} (${r.quantity} on ${formatDate(r.receivedOn)})`).join(", ")}
              </p>
            )}
            {d.references.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {d.references.map((r, i) => <li key={i}><span className="text-muted">{r.label}:</span> {r.value}</li>)}
              </ul>
            )}
            {d.run && (
              <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
                Checked by rule set <span className="text-text">{d.run.ruleSetVersion}</span> against invoice revision {d.run.invoiceRevision} on {formatDate(d.run.startedAt)}
                {d.run.status === "superseded" && <span className="text-warn"> · this check run has been superseded by a newer one</span>}
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-4 font-semibold">Review</h2>
            <dl className="mb-4 grid grid-cols-2 gap-4 text-sm">
              <Field label="Assignee">{d.assigneeName ?? d.assigneeEmail ?? "Unassigned"}</Field>
              {d.e.decidedAt && <Field label="Decided">{d.deciderName ?? d.deciderEmail} · {formatDate(d.e.decidedAt)}</Field>}
              {d.e.decisionReason && <div className="col-span-2"><Field label="Reason"><span className="whitespace-pre-line">{d.e.decisionReason}</span></Field></div>}
            </dl>
            <div className="space-y-5">
              {decidable && can(ctx.role, "exception.assign") && (
                <AssignForm exceptionId={d.e.id} revision={d.e.revision} current={d.e.assigneeUserId} assignees={options.assignees.map((a) => ({ userId: a.userId, label: a.name ?? a.email }))} />
              )}
              {d.status === "open" && can(ctx.role, "exception.decide") && <StartReviewForm exceptionId={d.e.id} revision={d.e.revision} />}
              {decidable && can(ctx.role, "exception.decide") && (
                <DecisionForm exceptionId={d.e.id} revision={d.e.revision} decisions={decisions} exposure={exposure} exposureLabel={amount ? formatMoney(amount, currency) : null} />
              )}
              {d.status === "correction_requested" && !d.e.confirmedCorrectionAmount && can(ctx.role, "exception.decide") && (
                <ConfirmCorrectionForm exceptionId={d.e.id} revision={d.e.revision} currency={currency ?? ""} />
              )}
              {!can(ctx.role, "exception.decide") && <p className="text-sm text-muted">You have view-only access to exceptions.</p>}
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">History</h2>
            {d.history.length === 0 ? (
              <p className="text-sm text-muted">No recorded activity yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {d.history.map((h) => {
                  const data = h.data as Record<string, unknown>;
                  return (
                    <li key={h.id} className="flex flex-wrap gap-x-2">
                      <span className="num text-muted">{formatDate(h.createdAt)}</span>
                      <span>{HISTORY_LABEL[h.action] ?? h.action}</span>
                      {typeof data.decision === "string" && <span className="text-muted">({data.decision.replace(/_/g, " ")})</span>}
                      <span className="text-muted">by {h.actorType === "system" ? "AvixCheck" : (h.actorName ?? h.actorEmail ?? "unknown")}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

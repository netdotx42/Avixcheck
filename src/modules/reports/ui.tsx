import Link from "next/link";
import { AlertTriangle, FlaskConical } from "lucide-react";
import { Card } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate, formatMoney } from "@/lib/format";
import type { CurrencyAmount } from "@/lib/metrics";
import type { Bucket, FailureSummary, OutcomeByCurrency, UnresolvedGroup, VolumePoint } from "./queries";

export const TYPE_LABEL: Record<string, string> = {
  price_variance: "Price variance",
  quantity_excess: "Excess quantity",
  receipt_quantity_exceeded: "Above received quantity",
  duplicate_invoice: "Possible duplicate",
  missing_discount: "Missing discount",
  unapproved_charge: "Unapproved charge",
  arithmetic_error: "Arithmetic error",
  currency_mismatch: "Currency mismatch",
  unit_mismatch: "Unit mismatch",
  po_balance_exceeded: "Above PO balance",
  missing_reference: "Missing reference",
  conflicting_reference: "Conflicting reference",
  missing_data: "Missing data",
  extraction_review: "Extraction needs review",
  matching_review: "Matching needs review",
  processing_failure: "Processing failure",
  discrepancy: "Discrepancy",
};

export const typeLabel = (k: string) => TYPE_LABEL[k] ?? k.replace(/_/g, " ");

export function DemoBanner() {
  return (
    <div role="note" className="card mb-6 flex items-start gap-3 border-warn/40 px-4 py-3 text-sm">
      <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div>
        <span className="font-medium text-warn">Demo organisation.</span>{" "}
        <span className="text-muted">These figures come from synthetic demo data and are kept separate from production organisations. Exports are labelled DEMO.</span>
      </div>
    </div>
  );
}

function periodLabel(period: string, bucket: Bucket) {
  const d = new Date(`${period}T00:00:00Z`);
  if (bucket === "month") return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

/** Stacked bar chart of received invoices and credit notes, with an accessible data table. */
export function VolumeChart({ points, bucket, title = "Invoice volume" }: { points: VolumePoint[]; bucket: Bucket; title?: string }) {
  const max = Math.max(1, ...points.map((p) => p.invoices + p.creditNotes));
  const total = points.reduce((n, p) => n + p.invoices + p.creditNotes, 0);
  const every = Math.ceil(points.length / 8);
  const per = bucket === "day" ? "day" : bucket === "week" ? "week" : "month";
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-primary" />Invoices</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-silver" />Credit notes</span>
          <span className="num">{total} received · per {per}</span>
        </div>
      </div>
      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted">No invoices received in this period.</p>
      ) : (
        <figure>
          <div className="flex h-40 items-end gap-1" aria-hidden>
            {points.map((p) => {
              const inv = (p.invoices / max) * 100;
              const cn = (p.creditNotes / max) * 100;
              return (
                <div key={p.period} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${periodLabel(p.period, bucket)}: ${p.invoices} invoices, ${p.creditNotes} credit notes`}>
                  {p.creditNotes > 0 && <div className="rounded-t-sm bg-silver/80" style={{ height: `${cn}%` }} />}
                  {p.invoices > 0 && <div className={`bg-primary ${p.creditNotes > 0 ? "" : "rounded-t-sm"}`} style={{ height: `${inv}%` }} />}
                  {p.invoices + p.creditNotes === 0 && <div className="h-px bg-border" />}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-1 text-[10px] text-muted" aria-hidden>
            {points.map((p, i) => (
              <div key={p.period} className="num min-w-0 flex-1 truncate text-center">{i % every === 0 ? periodLabel(p.period, bucket) : ""}</div>
            ))}
          </div>
          <figcaption className="sr-only">
            <table>
              <caption>{title} per {per}</caption>
              <thead><tr><th>Period starting</th><th>Invoices</th><th>Credit notes</th><th>Failed</th></tr></thead>
              <tbody>{points.map((p) => <tr key={p.period}><td>{p.period}</td><td>{p.invoices}</td><td>{p.creditNotes}</td><td>{p.failed}</td></tr>)}</tbody>
            </table>
          </figcaption>
        </figure>
      )}
    </Card>
  );
}

export function Amounts({ list, empty = "—" }: { list: CurrencyAmount[]; empty?: string }) {
  if (list.length === 0) return <span className="text-muted">{empty}</span>;
  return (
    <span className="flex flex-col items-end">
      {list.map((a) => <span key={a.currency} className="num whitespace-nowrap">{formatMoney(a.amount, a.currency)}</span>)}
    </span>
  );
}

/**
 * Money outcomes per currency. Potential exposure and realised savings sit in
 * separate, labelled columns and are never totalled together.
 */
export function OutcomesTable({ outcomes }: { outcomes: OutcomeByCurrency[] }) {
  return (
    <Card>
      <h2 className="font-semibold">Exposure and savings</h2>
      <p className="mb-4 mt-1 text-sm text-muted">
        Potential exposure is what open discrepancies could cost if paid as billed. Only supplier-confirmed corrections count as realised savings.
      </p>
      {outcomes.length === 0 ? (
        <p className="text-sm text-muted">No discrepancy amounts or confirmed corrections yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Currency</th>
                <th className="text-right"><span className="text-warn">Potential exposure</span></th>
                <th className="text-right">Awaiting supplier correction</th>
                <th className="text-right">Accepted variance</th>
                <th className="text-right"><span className="text-ok">Realised savings</span></th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => (
                <tr key={o.currency}>
                  <td className="font-medium">{o.currency}</td>
                  <td className="num text-right text-warn">{formatMoney(o.potentialExposure, o.currency)}</td>
                  <td className="num text-right">{formatMoney(o.awaitingCorrection, o.currency)}</td>
                  <td className="num text-right text-muted">{formatMoney(o.acceptedVariance, o.currency)}</td>
                  <td className="num text-right text-ok">{formatMoney(o.realisedSavings, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function UnresolvedTable({ title, description, groups, keyHeader, labelFor = typeLabel, emptyText, linkFor }: {
  title: string;
  keyHeader: string;
  description?: string;
  groups: UnresolvedGroup[];
  labelFor?: (k: string) => string;
  emptyText: string;
  linkFor?: (k: string) => string;
}) {
  const total = groups.reduce((n, g) => n + g.count, 0);
  return (
    <Card>
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      {total === 0 ? (
        <p className="mt-4 text-sm text-muted">{emptyText}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead><tr><th>{keyHeader}</th><th className="text-right">Open</th><th className="text-right">Potential exposure</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>{linkFor && g.count > 0 ? <Link className="hover:text-focus hover:underline" href={linkFor(g.key)}>{labelFor(g.key)}</Link> : labelFor(g.key)}</td>
                  <td className="num text-right">{g.count}</td>
                  <td className="text-right text-warn"><Amounts list={g.exposure} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function FailuresCard({ failures, canRecover }: { failures: FailureSummary; canRecover: boolean }) {
  const total = failures.failedInvoices + failures.quarantinedInvoices + failures.failedJobs + failures.openProcessingExceptions;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Processing failures</h2>
          <p className="mt-1 text-sm text-muted">Invoices and background jobs that stopped and need recovery. Nothing here is treated as passed.</p>
        </div>
        {total === 0 ? <StatusBadge tone="ok" label="None" /> : <StatusBadge tone="danger" label={`${total} need attention`} />}
      </div>
      {total > 0 && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-muted">Failed invoices</dt><dd className="num text-lg font-semibold">{failures.failedInvoices}</dd></div>
            <div><dt className="text-muted">Quarantined</dt><dd className="num text-lg font-semibold">{failures.quarantinedInvoices}</dd></div>
            <div><dt className="text-muted">Failed jobs</dt><dd className="num text-lg font-semibold">{failures.failedJobs}</dd></div>
            <div><dt className="text-muted">Open failure exceptions</dt><dd className="num text-lg font-semibold">{failures.openProcessingExceptions}</dd></div>
          </dl>
          {failures.recentInvoices.length > 0 && (
            <ul className="mt-4 divide-y divide-border/60 text-sm">
              {failures.recentInvoices.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/invoices/${f.id}`} className="min-w-0 truncate hover:text-focus hover:underline">{f.name}</Link>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    <StatusBadge tone={f.status === "quarantined" ? "warn" : "danger"} label={f.status === "quarantined" ? "Quarantined" : "Failed"} />
                    <span className="max-w-64 truncate" title={f.reason ?? undefined}>{f.reason ?? "No reason recorded"}</span>
                    <span className="num">{formatDate(f.updatedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/invoices?status=failed" className="btn btn-secondary">View failed invoices</Link>
            <Link href="/exceptions?type=processing_failure" className="btn btn-secondary">Failure exceptions</Link>
            {canRecover && failures.failedJobs > 0 && (
              <Link href="/settings" className="btn btn-primary"><AlertTriangle aria-hidden className="size-4" />Recover failed jobs</Link>
            )}
          </div>
        </>
      )}
    </Card>
  );
}


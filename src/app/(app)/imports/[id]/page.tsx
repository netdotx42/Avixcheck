import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/db/tenant";
import { formatDate } from "@/lib/format";
import { getBatchWithRows } from "@/modules/imports/queries";
import { ACTION_LABEL, ACTION_TONE, BATCH_STATUS, KIND_LABEL, SUMMARY_LABEL, UUID_RE, param } from "@/modules/imports/labels";
import { HANDLERS } from "@/modules/imports/kinds";
import type { RowError } from "@/modules/imports/fields";
import type { RowAction } from "@/modules/imports/types";
import { discardImportAction } from "@/app/actions/imports";
import { CommitForm } from "./commit-form";

export const metadata = { title: "Import preview" };

export default async function ImportPreviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await pageContext("reference.view");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const onlyErrors = param(sp.show) === "errors";
  const page = parsePage(sp.page);
  const data = await withTenant(ctx.orgId, (tx) => getBatchWithRows(tx, id, { onlyErrors, page }));
  if (!data) notFound();
  const { b, by, rows, total, pageSize } = data;
  const columns = HANDLERS[b.kind].columns;
  const canImport = can(ctx.role, "reference.import");
  const summary = Object.entries(b.summary as Record<string, number>).filter(([k, v]) => k !== "rows" && k !== "errors" && v);
  const status = BATCH_STATUS[b.status]!;

  return (
    <>
      <PageHeader
        title={b.fileName}
        description={`${KIND_LABEL[b.kind]} import · uploaded ${formatDate(b.createdAt)}${by ? ` by ${by}` : ""}`}
        actions={<Link className="btn btn-secondary" href="/imports">All imports</Link>}
      />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <StatusBadge {...status} />
                {b.committedAt && <span className="text-sm text-muted">Committed {formatDate(b.committedAt)}</span>}
              </div>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                <div><dt className="text-muted">Rows</dt><dd className="num text-lg font-semibold">{b.rowCount}</dd></div>
                <div><dt className="text-muted">Rows with errors</dt><dd className={`num text-lg font-semibold ${b.errorCount ? "text-danger" : ""}`}>{b.errorCount}</dd></div>
                {summary.map(([k, v]) => (
                  <div key={k}><dt className="text-muted">{SUMMARY_LABEL[k] ?? k}</dt><dd className="num text-lg font-semibold">{v}</dd></div>
                ))}
              </dl>
            </div>
            {b.status === "previewed" && canImport && (
              <div className="flex flex-col items-start gap-3 sm:items-end">
                <CommitForm
                  batchId={b.id}
                  disabled={b.errorCount > 0}
                  reason={b.errorCount > 0 ? "Fix the rows with errors in your file and upload it again. Nothing is saved while any row has an error." : "Rows are checked again against current data when you commit, all in one transaction."}
                />
                <form action={discardImportAction}>
                  <input type="hidden" name="batchId" value={b.id} />
                  <button className="text-sm text-muted underline hover:text-text">Discard this preview</button>
                </form>
              </div>
            )}
            {b.status === "committed" && (
              <p className="flex items-center gap-2 text-sm text-ok"><CheckCircle2 aria-hidden className="size-4" />Saved. Committing it again would change nothing.</p>
            )}
          </div>
        </Card>

        <section aria-labelledby="rows-h">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="rows-h" className="font-semibold">Rows</h2>
            <div className="flex gap-2 text-sm">
              <Link className={`btn ${onlyErrors ? "btn-secondary" : "btn-primary"} py-1`} href={`/imports/${b.id}`}>All</Link>
              <Link className={`btn ${onlyErrors ? "btn-primary" : "btn-secondary"} py-1`} href={`/imports/${b.id}?show=errors`}>Errors only</Link>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="card p-6 text-sm text-muted">{onlyErrors ? "No rows have errors." : "No rows."}</p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Result</th>
                    {columns.map((c) => <th key={c} scope="col" className="whitespace-nowrap">{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const errors = r.errors as RowError[];
                    const bad = new Set(errors.map((e) => e.field));
                    const raw = r.raw as Record<string, string>;
                    return (
                      <tr key={r.id} className={errors.length ? "bg-danger/5" : ""}>
                        <td className="num text-muted">{r.rowNumber}</td>
                        <td className="min-w-56">
                          {errors.length ? (
                            <div className="space-y-1">
                              <StatusBadge tone="danger" label={`${errors.length} error${errors.length > 1 ? "s" : ""}`} />
                              <ul className="space-y-0.5 text-xs text-danger">
                                {errors.map((e, i) => <li key={i}>{e.field ? <span className="font-mono">{e.field}: </span> : null}{e.message}</li>)}
                              </ul>
                            </div>
                          ) : r.action ? (
                            <StatusBadge tone={ACTION_TONE[r.action as RowAction]} label={ACTION_LABEL[r.action as RowAction]} />
                          ) : null}
                        </td>
                        {columns.map((c) => (
                          <td key={c} className={`whitespace-nowrap ${bad.has(c) ? "text-danger underline decoration-dotted" : ""}`}>{raw[c] || <span className="text-muted">—</span>}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page} pageSize={pageSize} total={total} basePath={`/imports/${b.id}`} params={{ show: onlyErrors ? "errors" : undefined }} />
        </section>
      </div>
    </>
  );
}

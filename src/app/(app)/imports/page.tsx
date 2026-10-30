import Link from "next/link";
import { FileSpreadsheet } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/db/tenant";
import { formatDate } from "@/lib/format";
import { listBatches, PAGE_SIZE } from "@/modules/imports/queries";
import { BATCH_STATUS, KIND_HELP, KIND_LABEL, param, pick } from "@/modules/imports/labels";
import { IMPORT_KINDS } from "@/modules/imports/types";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Imports" };

const STATUSES = ["previewed", "committed", "discarded"] as const;

export default async function ImportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await pageContext("reference.view");
  const sp = await searchParams;
  const kind = pick(param(sp.kind), IMPORT_KINDS);
  const status = pick(param(sp.status), STATUSES);
  const page = parsePage(sp.page);
  const canImport = can(ctx.role, "reference.import");
  const { rows, total } = await withTenant(ctx.orgId, (tx) => listBatches(tx, { kind, status, page }));
  const kinds = IMPORT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }));

  return (
    <>
      <PageHeader title="Imports" description="Load suppliers, purchase orders, price agreements, approved charges and receipts from CSV. Every row is validated before anything is saved." />
      <div className="space-y-6">
        {canImport ? (
          <Card>
            <h2 className="mb-4 font-semibold">New import</h2>
            <UploadForm kinds={kinds} initialKind={kind ?? "suppliers"} help={KIND_HELP} />
          </Card>
        ) : (
          <p className="text-sm text-muted">Only Admins can import reference data. You can review past imports below.</p>
        )}

        <section aria-labelledby="history">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <h2 id="history" className="font-semibold">History</h2>
            <form className="flex flex-wrap gap-2" method="get">
              <label className="sr-only" htmlFor="f-kind">Type</label>
              <select id="f-kind" name="kind" defaultValue={kind ?? ""} className="input w-auto py-1.5">
                <option value="">All types</option>
                {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <label className="sr-only" htmlFor="f-status">Status</label>
              <select id="f-status" name="status" defaultValue={status ?? ""} className="input w-auto py-1.5">
                <option value="">All statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{BATCH_STATUS[s]!.label}</option>)}
              </select>
              <button className="btn btn-secondary py-1.5">Filter</button>
            </form>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={FileSpreadsheet} title={kind || status ? "No imports match these filters" : "No imports yet"} body={canImport ? "Start with suppliers, then purchase orders and price agreements. Download a template above to see the expected columns." : "An Admin can import reference data from CSV templates."} />
          ) : (
            <div className="card overflow-x-auto">
              <table className="table">
                <thead><tr><th>File</th><th>Type</th><th>Status</th><th className="text-right">Rows</th><th className="text-right">Errors</th><th>Uploaded</th></tr></thead>
                <tbody>
                  {rows.map(({ b, by }) => (
                    <tr key={b.id}>
                      <td><Link className="text-focus hover:underline" href={`/imports/${b.id}`}>{b.fileName}</Link><div className="text-xs text-muted">{by ?? "—"}</div></td>
                      <td>{KIND_LABEL[b.kind]}</td>
                      <td><StatusBadge {...BATCH_STATUS[b.status]!} /></td>
                      <td className="num text-right">{b.rowCount}</td>
                      <td className={`num text-right ${b.errorCount ? "text-danger" : "text-muted"}`}>{b.errorCount}</td>
                      <td className="num text-muted">{formatDate(b.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/imports" params={{ kind, status }} />
        </section>
      </div>
    </>
  );
}

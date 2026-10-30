import type { ReactNode } from "react";
import Link from "next/link";
import { Building2, FileText, Truck } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { ImportLinks, Tabs } from "@/components/reference/import-links";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/db/tenant";
import { formatDate, formatMoney } from "@/lib/format";
import { agreementState, listAgreements, listCharges, listSuppliers, PAGE_SIZE, supplierOptions, type AgreementState } from "@/modules/imports/queries";
import { AGREEMENT_STATE, formatQty, param, pick, UUID_RE } from "@/modules/imports/labels";

export const metadata = { title: "Suppliers & Agreements" };

const TABS = ["suppliers", "agreements", "charges"] as const;
const STATES = ["current", "upcoming", "expired", "superseded", "all"] as const;

type SP = Record<string, string | string[] | undefined>;

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await pageContext("reference.view");
  const sp = await searchParams;
  const tab = pick(param(sp.tab), TABS) ?? "suppliers";
  const q = param(sp.q);
  const page = parsePage(sp.page);
  const supplierParam = param(sp.supplier);
  const supplierId = supplierParam && UUID_RE.test(supplierParam) ? supplierParam : undefined;
  const canImport = can(ctx.role, "reference.import");

  const importKinds = tab === "suppliers" ? (["suppliers"] as const) : tab === "agreements" ? (["price_agreements"] as const) : (["approved_charges"] as const);
  const tabs = [
    { key: "suppliers", label: "Suppliers", href: "/suppliers" },
    { key: "agreements", label: "Price agreements", href: "/suppliers?tab=agreements" },
    { key: "charges", label: "Approved charges", href: "/suppliers?tab=charges" },
  ];

  return (
    <>
      <PageHeader
        title="Suppliers & Agreements"
        description="Suppliers, dated price agreements and approved charges used to check invoices. Changes are versioned; earlier versions stay available for audit."
        actions={<ImportLinks kinds={[...importKinds]} canImport={canImport} />}
      />
      <Tabs tabs={tabs} active={tab} />
      {tab === "suppliers" && <SuppliersTab orgId={ctx.orgId} q={q} status={pick(param(sp.status), ["active", "inactive"] as const)} page={page} canImport={canImport} />}
      {tab === "agreements" && <AgreementsTab orgId={ctx.orgId} q={q} state={pick(param(sp.state), STATES)} supplierId={supplierId} page={page} canImport={canImport} />}
      {tab === "charges" && <ChargesTab orgId={ctx.orgId} q={q} state={pick(param(sp.state), STATES)} supplierId={supplierId} page={page} canImport={canImport} />}
    </>
  );
}

function SearchBar({ tab, q, children }: { tab: string; q?: string; children?: ReactNode }) {
  return (
    <form method="get" className="mb-4 flex flex-wrap gap-2" role="search">
      {tab !== "suppliers" && <input type="hidden" name="tab" value={tab} />}
      <label className="sr-only" htmlFor="q">Search</label>
      <input id="q" name="q" defaultValue={q} placeholder="Search code, name, SKU…" className="input w-64 max-w-full py-1.5" />
      {children}
      <button className="btn btn-secondary py-1.5">Search</button>
    </form>
  );
}

async function SuppliersTab({ orgId, q, status, page, canImport }: { orgId: string; q?: string; status?: "active" | "inactive"; page: number; canImport: boolean }) {
  const { rows, total } = await withTenant(orgId, (tx) => listSuppliers(tx, { q, status, page }));
  return (
    <>
      <SearchBar tab="suppliers" q={q}>
        <label className="sr-only" htmlFor="status">Status</label>
        <select id="status" name="status" defaultValue={status ?? ""} className="input w-auto py-1.5">
          <option value="">All suppliers</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      </SearchBar>
      {rows.length === 0 ? (
        q || status ? (
          <EmptyState icon={Building2} title="No suppliers match" body="Try a different search or clear the filters." action={<Link className="btn btn-secondary" href="/suppliers">Clear filters</Link>} />
        ) : (
          <EmptyState icon={Building2} title="No suppliers yet" body="Import suppliers from the CSV template to start matching invoices. Purchase orders and agreements refer to suppliers by code." action={canImport ? <Link className="btn btn-primary" href="/imports?kind=suppliers">Import suppliers</Link> : undefined} />
        )
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Tax ID</th><th>Currency</th><th className="text-right">Current agreements</th><th className="text-right">Open POs</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="font-mono text-xs"><Link className="text-focus hover:underline" href={`/suppliers/${s.id}`}>{s.code}</Link></td>
                  <td>{s.name}</td>
                  <td className="text-muted">{s.taxId ?? "—"}</td>
                  <td className="text-muted">{s.currency ?? "—"}</td>
                  <td className="num text-right">{s.agreements}</td>
                  <td className="num text-right">{s.openPos}</td>
                  <td>{s.active ? <StatusBadge tone="ok" label="Active" /> : <StatusBadge tone="neutral" label="Inactive" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/suppliers" params={{ q, status }} />
    </>
  );
}

async function SupplierFilter({ orgId, supplierId, state }: { orgId: string; supplierId?: string; state?: string }) {
  const options = await withTenant(orgId, (tx) => supplierOptions(tx));
  return (
    <>
      <label className="sr-only" htmlFor="supplier">Supplier</label>
      <select id="supplier" name="supplier" defaultValue={supplierId ?? ""} className="input w-auto max-w-56 py-1.5">
        <option value="">All suppliers</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.code} · {o.name}</option>)}
      </select>
      <label className="sr-only" htmlFor="state">Validity</label>
      <select id="state" name="state" defaultValue={state ?? ""} className="input w-auto py-1.5">
        <option value="">Not superseded</option>
        <option value="current">Current</option>
        <option value="upcoming">Upcoming</option>
        <option value="expired">Expired</option>
        <option value="superseded">Superseded versions</option>
        <option value="all">All versions</option>
      </select>
    </>
  );
}

async function AgreementsTab({ orgId, q, state, supplierId, page, canImport }: { orgId: string; q?: string; state?: AgreementState | "all"; supplierId?: string; page: number; canImport: boolean }) {
  const { rows, total } = await withTenant(orgId, (tx) => listAgreements(tx, { q, state, supplierId, page }));
  return (
    <>
      <SearchBar tab="agreements" q={q}><SupplierFilter orgId={orgId} supplierId={supplierId} state={state} /></SearchBar>
      {rows.length === 0 ? (
        <EmptyState icon={FileText} title={q || state || supplierId ? "No agreements match" : "No price agreements yet"} body="Price agreements set the expected unit price per supplier, SKU and unit for a date range. Without one, invoices are checked against the PO price." action={canImport && !q ? <Link className="btn btn-primary" href="/imports?kind=price_agreements">Import agreements</Link> : undefined} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Supplier</th><th>Agreement</th><th>SKU</th><th>Unit</th><th className="text-right">Unit price</th><th className="text-right">Discount</th><th className="text-right">Min qty</th><th>Valid</th><th>Version</th><th>State</th></tr></thead>
            <tbody>
              {rows.map(({ a, supplierCode }) => (
                <tr key={a.id}>
                  <td className="font-mono text-xs"><Link className="text-focus hover:underline" href={`/suppliers/${a.supplierId}`}>{supplierCode}</Link></td>
                  <td>{a.agreementRef}</td>
                  <td><div>{a.sku}</div>{a.description && <div className="text-xs text-muted">{a.description}</div>}</td>
                  <td>{a.unit}</td>
                  <td className="num whitespace-nowrap text-right">{a.currency} {formatQty(a.unitPrice)}</td>
                  <td className="num text-right">{formatQty(a.discountPct)}%</td>
                  <td className="num text-right">{formatQty(a.minQuantity)}</td>
                  <td className="num whitespace-nowrap text-muted">{formatDate(a.validFrom)} – {a.validTo ? formatDate(a.validTo) : "open"}</td>
                  <td className="num">v{a.version}</td>
                  <td><StatusBadge {...AGREEMENT_STATE[agreementState(a)]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/suppliers" params={{ tab: "agreements", q, state, supplier: supplierId }} />
    </>
  );
}

async function ChargesTab({ orgId, q, state, supplierId, page, canImport }: { orgId: string; q?: string; state?: AgreementState | "all"; supplierId?: string; page: number; canImport: boolean }) {
  const { rows, total } = await withTenant(orgId, (tx) => listCharges(tx, { q, state, supplierId, page }));
  return (
    <>
      <SearchBar tab="charges" q={q}><SupplierFilter orgId={orgId} supplierId={supplierId} state={state} /></SearchBar>
      {rows.length === 0 ? (
        <EmptyState icon={Truck} title={q || state || supplierId ? "No charges match" : "No approved charges yet"} body="Freight, handling and other non-goods charges on an invoice are flagged unless an approved charge covers them." action={canImport && !q ? <Link className="btn btn-primary" href="/imports?kind=approved_charges">Import charges</Link> : undefined} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Supplier</th><th>Charge type</th><th className="text-right">Maximum</th><th>Valid</th><th>Version</th><th>State</th></tr></thead>
            <tbody>
              {rows.map(({ c, supplierCode }) => (
                <tr key={c.id}>
                  <td className="font-mono text-xs"><Link className="text-focus hover:underline" href={`/suppliers/${c.supplierId}`}>{supplierCode}</Link></td>
                  <td>{c.chargeType}</td>
                  <td className="num text-right">{c.maxAmount ? formatMoney(c.maxAmount, c.currency) : <span className="text-muted">No cap ({c.currency})</span>}</td>
                  <td className="num whitespace-nowrap text-muted">{formatDate(c.validFrom)} – {c.validTo ? formatDate(c.validTo) : "open"}</td>
                  <td className="num">v{c.version}</td>
                  <td><StatusBadge {...AGREEMENT_STATE[agreementState(c)]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/suppliers" params={{ tab: "charges", q, state, supplier: supplierId }} />
    </>
  );
}

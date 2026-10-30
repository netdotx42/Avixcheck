"use client";
import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { correctInvoiceAction, type CorrectionState } from "@/app/actions/invoices";

type Header = {
  kind: "invoice" | "credit_note";
  supplierNameRaw: string | null;
  supplierTaxIdRaw: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  poNumberRaw: string | null;
  creditsInvoiceNumberRaw: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
};
type Line = {
  id: string | null;
  lineNo: number | null;
  lineType: "goods" | "charge" | "discount";
  chargeType: string | null;
  sku: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string | null;
  taxRate: string | null;
  poLineRef: string | null;
  extractionConfidence: string | null;
  manuallyCorrected: boolean;
};

const HEADER_FIELDS: { key: Exclude<keyof Header, "kind">; label: string; numeric?: boolean; placeholder?: string }[] = [
  { key: "supplierNameRaw", label: "Supplier name" },
  { key: "supplierTaxIdRaw", label: "Supplier tax ID" },
  { key: "invoiceNumber", label: "Invoice number" },
  { key: "invoiceDate", label: "Invoice date", placeholder: "YYYY-MM-DD" },
  { key: "dueDate", label: "Due date", placeholder: "YYYY-MM-DD" },
  { key: "currency", label: "Currency", placeholder: "GBP" },
  { key: "poNumberRaw", label: "PO number" },
  { key: "creditsInvoiceNumberRaw", label: "Credits invoice no." },
  { key: "subtotal", label: "Subtotal", numeric: true },
  { key: "taxTotal", label: "Tax", numeric: true },
  { key: "total", label: "Total", numeric: true },
];

const LINE_COLS: { key: keyof Line; label: string; numeric?: boolean; width: string }[] = [
  { key: "sku", label: "SKU", width: "w-24" },
  { key: "description", label: "Description", width: "min-w-48" },
  { key: "quantity", label: "Qty", numeric: true, width: "w-24" },
  { key: "unit", label: "Unit", width: "w-20" },
  { key: "unitPrice", label: "Unit price", numeric: true, width: "w-28" },
  { key: "amount", label: "Amount", numeric: true, width: "w-28" },
  { key: "taxRate", label: "Tax %", numeric: true, width: "w-20" },
  { key: "poLineRef", label: "PO line", width: "w-20" },
];

const blankLine = (): Line => ({ id: null, lineNo: null, lineType: "goods", chargeType: null, sku: null, description: null, quantity: null, unit: null, unitPrice: null, amount: null, taxRate: null, poLineRef: null, extractionConfidence: null, manuallyCorrected: true });
const lowConf = (c: string | null) => c !== null && Number(c) < 0.9;

export function InvoiceEditor({ editable, inReview, invoiceId, revision, header: initialHeader, lines: initialLines }: { editable: boolean; inReview: boolean; invoiceId: string; revision: number; header: Header; lines: Line[] }) {
  const [header, setHeader] = useState(initialHeader);
  const [lines, setLines] = useState(initialLines);
  const [state, action, pending] = useActionState<CorrectionState, FormData>(correctInvoiceAction, null);

  const payload = JSON.stringify({
    header,
    lines: lines.map(({ id, lineType, chargeType, sku, description, quantity, unit, unitPrice, amount, taxRate, poLineRef }) => ({ id, lineType, chargeType, sku, description, quantity, unit, unitPrice, amount, taxRate, poLineRef })),
  });
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...p } : l)));
  const val = (v: string | null) => v ?? "";
  const orNull = (v: string) => (v.trim() === "" ? null : v);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="revision" value={revision} />
      <input type="hidden" name="payload" value={payload} />
      <fieldset disabled={!editable || pending} className="space-y-5">
        <legend className="sr-only">Invoice header</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="label" htmlFor="h-kind">Document type</label>
            <select id="h-kind" className="input" value={header.kind} onChange={(e) => setHeader({ ...header, kind: e.target.value as Header["kind"] })}>
              <option value="invoice">Invoice</option>
              <option value="credit_note">Credit note</option>
            </select>
          </div>
          {HEADER_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="label" htmlFor={`h-${f.key}`}>{f.label}</label>
              <input id={`h-${f.key}`} className={`input ${f.numeric ? "num text-right" : ""}`} inputMode={f.numeric ? "decimal" : undefined} placeholder={f.placeholder} value={val(header[f.key])} onChange={(e) => setHeader({ ...header, [f.key]: orNull(e.target.value) })} />
            </div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Line items</caption>
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                {LINE_COLS.map((c) => <th key={c.key} className={c.numeric ? "text-right" : ""}>{c.label}</th>)}
                <th><span className="sr-only">Status</span></th>
                {editable && <th><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={LINE_COLS.length + 4} className="text-sm text-muted">No line items.</td></tr>}
              {lines.map((l, i) => (
                <tr key={l.id ?? `new-${i}`}>
                  <td className="num text-muted">{l.lineNo ?? "new"}</td>
                  <td>
                    <label className="sr-only" htmlFor={`l${i}-type`}>Line {i + 1} type</label>
                    <select id={`l${i}-type`} className="input w-28 py-1" value={l.lineType} onChange={(e) => setLine(i, { lineType: e.target.value as Line["lineType"] })}>
                      <option value="goods">Goods</option>
                      <option value="charge">Charge</option>
                      <option value="discount">Discount</option>
                    </select>
                    {l.lineType === "charge" && (
                      <input aria-label={`Line ${i + 1} charge type`} placeholder="Charge type" className="input mt-1 w-28 py-1" value={val(l.chargeType)} onChange={(e) => setLine(i, { chargeType: orNull(e.target.value) })} />
                    )}
                  </td>
                  {LINE_COLS.map((c) => (
                    <td key={c.key}>
                      <input
                        aria-label={`Line ${i + 1} ${c.label}`}
                        className={`input py-1 ${c.width} ${c.numeric ? "num text-right" : ""}`}
                        inputMode={c.numeric ? "decimal" : undefined}
                        value={val(l[c.key] as string | null)}
                        onChange={(e) => setLine(i, { [c.key]: orNull(e.target.value) } as Partial<Line>)}
                      />
                    </td>
                  ))}
                  <td className="whitespace-nowrap text-xs">
                    {l.manuallyCorrected ? <span className="text-info">Corrected</span> : lowConf(l.extractionConfidence) ? <span className="text-warn">Low confidence</span> : null}
                  </td>
                  {editable && (
                    <td>
                      <button type="button" className="text-muted hover:text-danger" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>

      {editable && inReview && (
        <p className="text-xs text-muted">If every value matches the document, saving without changes confirms the extraction and sends the invoice on to matching.</p>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-secondary" onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={pending}><Plus aria-hidden className="size-4" />Add line</button>
          <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : inReview ? "Save and confirm values" : "Save corrections"}</button>
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => { setHeader(initialHeader); setLines(initialLines); }}>Reset</button>
        </div>
      )}
      {state?.ok === false && (
        <p role="alert" className="text-sm text-danger">
          {state.error} {state.conflict && <button type="button" className="underline" onClick={() => window.location.reload()}>Reload</button>}
        </p>
      )}
      {state?.ok && (
        <p role="status" className={`text-sm ${state.missing.length ? "text-warn" : "text-ok"}`}>
          {state.missing.length
            ? `Saved as revision ${state.revision}. Still missing: ${state.missing.join(", ")}. The invoice stays in review until these are filled in.`
            : state.confirmed
              ? `Values confirmed (revision ${state.revision}). Matching and checks will run.`
              : state.changed
                ? `Saved as revision ${state.revision}. Matching and checks will re-run.`
                : "No changes to save."}
        </p>
      )}
    </form>
  );
}

"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate, formatMoney } from "@/lib/format";
import { STATUS_TONE, typeLabel } from "@/modules/exceptions/display";
import { STATUS_LABEL, type ExceptionStatus } from "@/modules/exceptions/rules";
import { bulkAssignAction, type ActionState } from "./actions";

export interface Row {
  id: string;
  title: string;
  kind: string;
  status: string;
  revision: number;
  createdAt: string;
  confirmedCorrectionAmount: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  type: string | null;
  amount: string | null;
  currency: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  supplierName: string | null;
  supplierNameRaw: string | null;
}

export function ExceptionTable({ rows, assignees, canAssign }: { rows: Row[]; assignees: { userId: string; label: string }[]; canAssign: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(bulkAssignAction, null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <form action={action} className="card overflow-hidden">
      {canAssign && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3 text-sm">
          <span className="num text-muted">{selected.size} selected</span>
          <label className="sr-only" htmlFor="bulk-assignee">Assign selected to</label>
          <select id="bulk-assignee" name="assigneeUserId" className="input w-auto py-1" defaultValue="me">
            <option value="me">Assign to me</option>
            {assignees.map((a) => <option key={a.userId} value={a.userId}>{a.label}</option>)}
            <option value="">Unassign</option>
          </select>
          <button className="btn btn-secondary py-1" disabled={pending || selected.size === 0}>{pending ? "Saving…" : "Apply to selected"}</button>
          {state && (
            <span role={state.ok ? "status" : "alert"} className={state.ok ? "text-muted" : "text-danger"}>
              {state.ok ? state.message : state.error}
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {canAssign && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
              )}
              <th>Exception</th>
              <th>Status</th>
              <th>Invoice</th>
              <th className="text-right">Potential exposure</th>
              <th>Assignee</th>
              <th>Raised</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {canAssign && (
                  <td>
                    <input
                      type="checkbox"
                      name="selected"
                      value={`${r.id}:${r.revision}`}
                      aria-label={`Select ${r.title}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                )}
                <td className="max-w-sm">
                  <Link href={`/exceptions/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
                  <div className="text-xs text-muted">{typeLabel(r.type, r.kind)}</div>
                </td>
                <td>
                  <StatusBadge tone={STATUS_TONE[r.status as ExceptionStatus]} label={STATUS_LABEL[r.status as ExceptionStatus]} />
                  {r.confirmedCorrectionAmount && <div className="num mt-1 text-xs text-ok">Saved {formatMoney(r.confirmedCorrectionAmount, r.currency)}</div>}
                </td>
                <td>
                  <div>{r.invoiceNumber ?? <span className="text-muted">No number</span>}</div>
                  <div className="text-xs text-muted">{r.supplierName ?? r.supplierNameRaw ?? "Unmatched supplier"}</div>
                </td>
                <td className="num text-right">{r.amount ? formatMoney(r.amount, r.currency) : <span className="text-muted">—</span>}</td>
                <td className="text-muted">{r.assigneeName ?? r.assigneeEmail ?? "Unassigned"}</td>
                <td className="num text-muted">{formatDate(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  );
}

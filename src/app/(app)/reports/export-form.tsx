"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { createExportAction, type ExportFormState } from "./actions";

export function ExportForm({ kinds, filters, disabledReason }: {
  kinds: { value: string; label: string; description: string }[];
  filters: { from: string; to: string; supplier?: string };
  disabledReason?: string;
}) {
  const [state, action, pending] = useActionState<ExportFormState, FormData>(createExportAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="from" value={filters.from} />
      <input type="hidden" name="to" value={filters.to} />
      <input type="hidden" name="supplier" value={filters.supplier ?? ""} />
      <fieldset disabled={!!disabledReason || pending} className="space-y-2">
        <legend className="label">What to export</legend>
        {kinds.map((k, i) => (
          <label key={k.value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary/70 has-[:checked]:bg-primary/10">
            <input type="radio" name="kind" value={k.value} defaultChecked={i === 0} className="mt-1 accent-[#2563eb]" />
            <span>
              <span className="block text-sm font-medium">{k.label}</span>
              <span className="block text-xs text-muted">{k.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted">Uses the date range and supplier filter above. Files are generated in the background, stored privately, and expire per your retention setting.</p>
      <button className="btn btn-primary" disabled={!!disabledReason || pending}>
        <Download aria-hidden className="size-4" />{pending ? "Queuing…" : "Create CSV export"}
      </button>
      {disabledReason && <p className="text-sm text-muted">{disabledReason}</p>}
      {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p role="status" className="text-sm text-ok">Export queued. It appears in the list below when ready.</p>}
    </form>
  );
}

/** Refreshes the server-rendered export list while any export is still generating. */
export function AutoRefresh({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}

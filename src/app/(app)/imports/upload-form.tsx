"use client";
import { useActionState, useState } from "react";
import { Upload } from "lucide-react";
import { uploadImportAction, type UploadState } from "@/app/actions/imports";

export function UploadForm({ kinds, initialKind, help }: { kinds: { value: string; label: string }[]; initialKind: string; help: Record<string, string> }) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadImportAction, null);
  const [kind, setKind] = useState(initialKind);
  return (
    <form action={action} className="space-y-4" aria-describedby="import-help">
      <div className="grid gap-4 sm:grid-cols-[14rem_1fr_auto]">
        <div>
          <label className="label" htmlFor="import-kind">Import type</label>
          <select id="import-kind" name="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="import-file">CSV file (UTF-8, up to 1.9 MB / 20,000 rows)</label>
          <input id="import-file" name="file" type="file" accept=".csv,text/csv" required className="input file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1 file:text-text" />
        </div>
        <div className="flex items-end">
          <button className="btn btn-primary" disabled={pending}>
            <Upload aria-hidden className="size-4" />
            {pending ? "Validating…" : "Upload and preview"}
          </button>
        </div>
      </div>
      <p id="import-help" className="text-sm text-muted">
        {help[kind]} Nothing is saved until you review the preview and commit it.{" "}
        <a className="text-focus underline" href={`/api/import-templates/${kind}`} download>Download the template</a>.
      </p>
      {state?.ok === false && <p role="alert" className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

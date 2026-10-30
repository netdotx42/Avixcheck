"use client";
import { useActionState } from "react";
import { CheckCircle2 } from "lucide-react";
import { commitImportAction, type CommitState } from "@/app/actions/imports";

export function CommitForm({ batchId, disabled, reason }: { batchId: string; disabled: boolean; reason?: string }) {
  const [state, action, pending] = useActionState<CommitState, FormData>(commitImportAction, null);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <button className="btn btn-primary" disabled={disabled || pending} aria-describedby={reason ? "commit-reason" : undefined}>
        <CheckCircle2 aria-hidden className="size-4" />
        {pending ? "Committing…" : "Commit import"}
      </button>
      {reason && <p id="commit-reason" className="text-xs text-muted">{reason}</p>}
      {state && <p role={state.ok ? "status" : "alert"} className={`text-sm ${state.ok ? "text-ok" : "text-danger"}`}>{state.message}</p>}
    </form>
  );
}

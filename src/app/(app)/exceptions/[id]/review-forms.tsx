"use client";
import { useActionState, useState } from "react";
import { DECISION_LABEL, reasonRequired, type Decision } from "@/modules/exceptions/rules";
import { assignAction, confirmCorrectionAction, decideAction, startReviewAction, type ActionState } from "../actions";

function Result({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.ok) return <p role="status" className="text-sm text-ok">{state.message}</p>;
  return (
    <p role="alert" className="text-sm text-danger">
      {state.error}
      {state.conflict && (
        <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>Reload</button>
      )}
    </p>
  );
}

function Hidden({ exceptionId, revision }: { exceptionId: string; revision: number }) {
  return (
    <>
      <input type="hidden" name="exceptionId" value={exceptionId} />
      <input type="hidden" name="revision" value={revision} />
    </>
  );
}

export function AssignForm({ exceptionId, revision, current, assignees }: { exceptionId: string; revision: number; current: string | null; assignees: { userId: string; label: string }[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(assignAction, null);
  return (
    <form action={action} className="space-y-2">
      <Hidden exceptionId={exceptionId} revision={revision} />
      <label className="label" htmlFor="assignee">Assign to</label>
      <div className="flex gap-2">
        <select id="assignee" name="assigneeUserId" defaultValue={current ?? ""} className="input">
          <option value="">Unassigned</option>
          {assignees.map((a) => <option key={a.userId} value={a.userId}>{a.label}</option>)}
        </select>
        <button className="btn btn-secondary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function StartReviewForm({ exceptionId, revision }: { exceptionId: string; revision: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(startReviewAction, null);
  return (
    <form action={action} className="space-y-2">
      <Hidden exceptionId={exceptionId} revision={revision} />
      <button className="btn btn-secondary" disabled={pending}>{pending ? "Starting…" : "Start review"}</button>
      <Result state={state} />
    </form>
  );
}

const HELP: Record<Decision, string> = {
  accept_variance: "Authorise paying the invoice as billed despite the difference. Admin only.",
  request_correction: "Ask the supplier for a credit note or corrected invoice. Record the confirmed amount when it arrives.",
  reject_invoice: "The invoice will not be processed further. This is final.",
  dismiss: "The check does not apply here (for example, a false positive). Explain why.",
};

export function DecisionForm({
  exceptionId,
  revision,
  decisions,
  exposure,
  exposureLabel,
}: {
  exceptionId: string;
  revision: number;
  decisions: { decision: Decision; allowed: boolean }[];
  exposure: boolean;
  exposureLabel: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(decideAction, null);
  const firstAllowed = decisions.find((d) => d.allowed)?.decision;
  const [choice, setChoice] = useState<Decision | undefined>(firstAllowed);
  if (!firstAllowed) return <p className="text-sm text-muted">Only an Admin can decide this exception.</p>;
  const required = choice ? reasonRequired(choice) : true;
  return (
    <form action={action} className="space-y-3 border-t border-border pt-4">
      <Hidden exceptionId={exceptionId} revision={revision} />
      <fieldset>
        <legend className="label">Decision</legend>
        <div className="space-y-2">
          {decisions.map(({ decision, allowed }) => (
            <label key={decision} className={`flex gap-2 rounded-md border border-border p-2 text-sm ${allowed ? "cursor-pointer hover:border-silver" : "opacity-50"}`}>
              <input type="radio" name="decision" value={decision} disabled={!allowed} checked={choice === decision} onChange={() => setChoice(decision)} />
              <span>
                <span className="font-medium">{DECISION_LABEL[decision]}</span>
                <span className="block text-xs text-muted">{allowed ? HELP[decision] : "Requires Admin because this discrepancy carries financial exposure."}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor="reason">Reason{required ? "" : " (optional)"}</label>
        <textarea id="reason" name="reason" required={required} minLength={required ? 3 : undefined} maxLength={2000} rows={3} className="input" />
      </div>
      {choice === "accept_variance" && exposure && (
        <label className="flex gap-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-sm">
          <input type="checkbox" name="confirmAboveTolerance" required />
          <span>I authorise accepting a variance above tolerance{exposureLabel ? ` of ${exposureLabel}` : ""}.</span>
        </label>
      )}
      <button className="btn btn-primary" disabled={pending || !choice}>{pending ? "Recording…" : "Record decision"}</button>
      <Result state={state} />
    </form>
  );
}

export function ConfirmCorrectionForm({ exceptionId, revision, currency }: { exceptionId: string; revision: number; currency: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(confirmCorrectionAction, null);
  return (
    <form action={action} className="space-y-3 border-t border-border pt-4">
      <Hidden exceptionId={exceptionId} revision={revision} />
      <p className="text-sm text-muted">When the supplier confirms the correction, record the amount saved. This is counted as a realised saving.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="corr-amount">Confirmed amount{currency ? ` (${currency})` : ""}</label>
          <input id="corr-amount" name="amount" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,4})?" required className="input num" />
        </div>
        <div>
          <label className="label" htmlFor="corr-ref">Credit note / corrected invoice ref</label>
          <input id="corr-ref" name="reference" required maxLength={200} className="input" />
        </div>
      </div>
      <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Record confirmed correction"}</button>
      <Result state={state} />
    </form>
  );
}

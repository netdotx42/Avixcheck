"use client";
import { useActionState } from "react";
import { inviteMemberAction, type InviteState } from "@/app/actions/orgs";

export function InviteForm({ emailConfigured }: { emailConfigured: boolean }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteMemberAction, null);
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto]">
        <div>
          <label className="label" htmlFor="invite-email">Email</label>
          <input id="invite-email" name="email" type="email" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="invite-role">Role</label>
          <select id="invite-role" name="role" className="input" defaultValue="reviewer">
            <option value="admin">Admin</option>
            <option value="reviewer">Reviewer</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <div className="flex items-end">
          <button className="btn btn-primary" disabled={pending}>{pending ? "Inviting…" : "Invite"}</button>
        </div>
      </div>
      {state?.ok === false && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      {state?.ok && (
        <div role="status" className="rounded-md border border-border bg-bg p-3 text-sm">
          <p>
            Invitation created for {state.email}.{" "}
            {emailConfigured ? "" : "Email delivery is not configured, so share this one-time link with them directly. It expires in 7 days."}
          </p>
          <code className="mt-2 block break-all text-xs text-focus">{state.link}</code>
        </div>
      )}
    </form>
  );
}

import { and, desc, eq, isNull, gt } from "drizzle-orm";
import { Card, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { can } from "@/lib/auth/permissions";
import { listMembers } from "@/lib/orgs";
import { withTenant } from "@/db/tenant";
import { invitations, jobs } from "@/db/schema";
import { integrationStatus } from "@/env";
import { formatDate } from "@/lib/format";
import { changeRoleAction, removeMemberAction, revokeInvitationAction } from "@/app/actions/orgs";
import { cancelJobAction, retryJobAction } from "@/app/actions/jobs";
import { InviteForm } from "./invite-form";
import { RetentionCard } from "./retention-card";

export const metadata = { title: "Settings" };

const ROLE_LABEL = { admin: "Admin", reviewer: "Reviewer", viewer: "Viewer" } as const;

export default async function SettingsPage() {
  const ctx = await pageContext("org.view");
  const isAdmin = can(ctx.role, "members.manage");
  const members = await listMembers(ctx.orgId);
  const { pending, failedJobs } = await withTenant(ctx.orgId, async (tx) => ({
    pending: isAdmin
      ? await tx.select().from(invitations).where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))).orderBy(desc(invitations.createdAt))
      : [],
    failedJobs: can(ctx.role, "jobs.view")
      ? await tx.select().from(jobs).where(eq(jobs.status, "failed")).orderBy(desc(jobs.updatedAt)).limit(50)
      : [],
  }));

  return (
    <>
      <PageHeader title="Settings" description="Members, roles, integrations and background job recovery." />
      <div className="space-y-6">
        <Card>
          <h2 className="mb-4 font-semibold">Members</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Member</th><th>Role</th><th>Joined</th>{isAdmin && <th className="text-right">Actions</th>}</tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td><div>{m.name ?? m.email}</div>{m.name && <div className="text-xs text-muted">{m.email}</div>}</td>
                    <td>
                      {isAdmin && m.userId !== ctx.user.id ? (
                        <form action={changeRoleAction} className="flex gap-2">
                          <input type="hidden" name="userId" value={m.userId} />
                          <label className="sr-only" htmlFor={`role-${m.userId}`}>Role for {m.email}</label>
                          <select id={`role-${m.userId}`} name="role" defaultValue={m.role} className="input w-auto py-1">
                            <option value="admin">Admin</option><option value="reviewer">Reviewer</option><option value="viewer">Viewer</option>
                          </select>
                          <button className="btn btn-secondary py-1">Save</button>
                        </form>
                      ) : ROLE_LABEL[m.role]}
                    </td>
                    <td className="num text-muted">{formatDate(m.joinedAt)}</td>
                    {isAdmin && (
                      <td className="text-right">
                        {m.userId !== ctx.user.id && (
                          <form action={removeMemberAction}><input type="hidden" name="userId" value={m.userId} /><button className="text-sm text-danger hover:underline">Remove</button></form>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {isAdmin && (
          <Card>
            <h2 className="mb-4 font-semibold">Invite people</h2>
            <InviteForm />
            {pending.length > 0 && (
              <ul className="mt-5 divide-y divide-border text-sm">
                {pending.map((i) => (
                  <li key={i.id} className="flex items-center justify-between py-2">
                    <span>{i.email} · {ROLE_LABEL[i.role]} · <span className="text-muted">expires {formatDate(i.expiresAt)}</span></span>
                    <form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={i.id} /><button className="text-danger hover:underline">Revoke</button></form>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {can(ctx.role, "jobs.view") && (
          <Card>
            <h2 className="mb-1 font-semibold">Failed background jobs</h2>
            <p className="mb-4 text-sm text-muted">Jobs that exhausted their retries or hit a permanent error. Retrying is safe: handlers are idempotent.</p>
            {failedJobs.length === 0 ? (
              <p className="text-sm text-muted">No failed jobs.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Type</th><th>Attempts</th><th>Error</th><th>Updated</th>{can(ctx.role, "jobs.recover") && <th className="text-right">Recover</th>}</tr></thead>
                  <tbody>
                    {failedJobs.map((j) => (
                      <tr key={j.id}>
                        <td><StatusBadge tone="danger" label={j.type} /></td>
                        <td className="num">{j.attempts}/{j.maxAttempts}</td>
                        <td className="max-w-md truncate text-muted" title={j.lastError ?? ""}>{j.lastError}</td>
                        <td className="num text-muted">{formatDate(j.updatedAt)}</td>
                        {can(ctx.role, "jobs.recover") && (
                          <td className="text-right">
                            <div className="flex justify-end gap-2">
                              <form action={retryJobAction}><input type="hidden" name="jobId" value={j.id} /><button className="btn btn-secondary py-1">Retry</button></form>
                              <form action={cancelJobAction}><input type="hidden" name="jobId" value={j.id} /><button className="btn btn-secondary py-1">Dismiss</button></form>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {can(ctx.role, "retention.manage") && <RetentionCard orgId={ctx.orgId} />}

        <Card>
          <h2 className="mb-4 font-semibold">Integrations</h2>
          <ul className="space-y-2 text-sm">
            {integrationStatus().map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-4">
                <span>{s.label}</span>
                <StatusBadge tone={s.configured ? "ok" : s.required ? "danger" : "neutral"} label={s.configured ? "Configured" : s.required ? "Missing" : "Not configured"} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

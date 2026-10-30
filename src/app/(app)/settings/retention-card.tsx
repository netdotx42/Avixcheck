import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Card } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { documents, jobs } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { isConfigured } from "@/env";
import { formatDate } from "@/lib/format";
import { JOB_TYPES } from "@/lib/jobs/registry";
import { retentionCandidates } from "@/modules/ops/retention";
import { runRetentionSweepAction } from "@/app/actions/retention";

/** Retention policy, what is due, legal holds and the last sweep. Admin only (retention.manage). */
export async function RetentionCard({ orgId }: { orgId: string }) {
  const due = await retentionCandidates(orgId, new Date(), 500);
  const { held, lastSweep } = await withTenant(orgId, async (tx) => ({
    held: (await tx.select({ n: count() }).from(documents).where(and(eq(documents.legalHold, true), isNull(documents.deletedAt))))[0]?.n ?? 0,
    lastSweep: (await tx.select().from(jobs).where(eq(jobs.type, JOB_TYPES.retentionSweep)).orderBy(desc(jobs.createdAt)).limit(1))[0],
  }));
  const storage = isConfigured("storage");
  const fmtCount = (ids: string[]) => (ids.length > 500 ? "500+" : String(ids.length));
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Data retention</h2>
      <p className="mb-4 text-sm text-muted">
        Invoice PDFs are deleted {due.policy.documentDays} days after upload and exports {due.policy.exportDays} days after they are generated. Records, check results and the audit trail are kept. Documents on legal hold are never deleted. Sweeps run daily.
      </p>
      <dl className="mb-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div><dt className="text-muted">Documents due</dt><dd className="num">{fmtCount(due.documentIds)}</dd></div>
        <div><dt className="text-muted">Exports due</dt><dd className="num">{fmtCount(due.exportIds)}</dd></div>
        <div><dt className="text-muted">On legal hold</dt><dd className="num">{held}</dd></div>
        <div>
          <dt className="text-muted">Last sweep</dt>
          <dd>
            {lastSweep ? (
              <StatusBadge tone={lastSweep.status === "succeeded" ? "ok" : lastSweep.status === "failed" ? "danger" : "neutral"} label={`${lastSweep.status} · ${formatDate(lastSweep.updatedAt)}`} />
            ) : (
              <span className="text-muted">Not run yet</span>
            )}
          </dd>
        </div>
      </dl>
      {!storage && <p className="mb-3 text-sm text-muted">Object storage is not configured, so sweeps that have files to delete will fail visibly instead of running.</p>}
      <form action={runRetentionSweepAction}><button className="btn btn-secondary">Run sweep now</button></form>
    </Card>
  );
}

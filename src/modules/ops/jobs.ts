import { isConfigured } from "@/env";
import { PermanentJobError } from "@/lib/jobs/queue";
import { JOB_TYPES, registerHandler } from "@/lib/jobs/registry";
import { retentionCandidates, sweepRetention } from "./retention";

/**
 * ops.retention_sweep: idempotent (already-deleted documents and expired
 * exports are skipped), so at-least-once delivery is safe.
 */
registerHandler(JOB_TYPES.retentionSweep, async ({ orgId, job }) => {
  const pending = await retentionCandidates(orgId, new Date(), 1);
  const due = pending.documentIds.length + pending.exportIds.length;
  if (due > 0 && !isConfigured("storage")) {
    // Never mark files deleted that we could not delete.
    throw new PermanentJobError("Retention sweep needs object storage, which is not configured (S3_* variables)");
  }
  return sweepRetention(orgId, { jobId: job.id });
});

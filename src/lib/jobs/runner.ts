import { logger, reportError } from "../logger";
import { claimNext, completeJob, failJob, PermanentJobError, sweepAbandoned } from "./queue";
import { getHandler, registeredTypes } from "./registry";

/** Claim and run one job. Returns false when nothing was runnable. */
export async function runOnce(workerId: string): Promise<boolean> {
  const types = registeredTypes();
  if (types.length === 0) return false;
  const job = await claimNext(workerId, types);
  if (!job) return false;
  const log = logger.child({ jobId: job.id, jobType: job.type, orgId: job.orgId, attempt: job.attempts });
  const handler = getHandler(job.type);
  try {
    if (!handler) throw new PermanentJobError(`No handler for job type ${job.type}`);
    if (!job.orgId) throw new PermanentJobError("Tenant job without org id");
    log.info("job started");
    const result = await handler({ job, orgId: job.orgId, workerId });
    await completeJob(job, workerId, result ?? null);
    log.info("job succeeded");
  } catch (err) {
    reportError(err, { jobId: job.id, jobType: job.type, orgId: job.orgId });
    await failJob(job, workerId, err);
  }
  return true;
}

export async function runWorkerLoop(workerId: string, signal: AbortSignal, idleMs = 1000) {
  let lastSweep = 0;
  while (!signal.aborted) {
    if (Date.now() - lastSweep > 60_000) {
      lastSweep = Date.now();
      const n = await sweepAbandoned().catch((e) => (reportError(e, { op: "sweep" }), 0));
      if (n) logger.warn({ count: n }, "marked abandoned jobs failed");
    }
    const didWork = await runOnce(workerId).catch((e) => (reportError(e, { op: "runOnce" }), false));
    if (!didWork) await new Promise((r) => setTimeout(r, idleMs));
  }
}

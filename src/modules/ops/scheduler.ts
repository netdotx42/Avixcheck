import { organizations } from "@/db/schema";
import { withSystem, withTenant } from "@/db/tenant";
import { enqueue } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES } from "@/lib/jobs/registry";
import { logger, reportError } from "@/lib/logger";

/**
 * Enqueue one retention sweep per organisation per UTC day. The idempotency key
 * includes the date, so every worker instance can call this safely; only the
 * first enqueue per org/day creates a job.
 */
export async function scheduleDailyJobs(now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const orgs = await withSystem((tx) => tx.select({ id: organizations.id }).from(organizations));
  let created = 0;
  for (const { id } of orgs) {
    const r = await withTenant(id, (tx) =>
      enqueue(tx, { orgId: id, type: JOB_TYPES.retentionSweep, idempotencyKey: idempotencyKey(id, JOB_TYPES.retentionSweep, day), maxAttempts: 3 }),
    );
    if (r.created) created++;
  }
  return created;
}

/** Run the scheduler now and then every `intervalMs` until `signal` aborts. */
export function startScheduler(signal: AbortSignal, intervalMs = 60 * 60 * 1000) {
  const tick = () =>
    scheduleDailyJobs()
      .then((n) => n > 0 && logger.info({ created: n }, "scheduled daily maintenance jobs"))
      .catch((err) => reportError(err, { component: "scheduler" }));
  void tick();
  const timer = setInterval(tick, intervalMs);
  signal.addEventListener("abort", () => clearInterval(timer));
}

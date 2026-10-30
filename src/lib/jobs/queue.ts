import { and, eq, inArray, sql } from "drizzle-orm";
import { jobs } from "@/db/schema";
import type { Tx } from "@/db/client";
import { withSystem, withTenant } from "@/db/tenant";
import { audit } from "../audit";
import { assertCan, type Role } from "../auth/permissions";

/**
 * Durable Postgres-backed job queue.
 *
 * Guarantees
 * - Idempotent enqueue: (type, idempotency_key) is unique; enqueueing the same
 *   key again returns the existing job instead of creating a duplicate.
 * - At-least-once execution with `FOR UPDATE SKIP LOCKED` claiming, so two
 *   workers never run the same job at once. Handlers MUST be idempotent.
 * - Bounded retries with exponential backoff; exhausted or non-retryable jobs
 *   land in `failed` with `last_error` visible in the UI.
 * - Stale `running` jobs (worker crashed) are reclaimed after a lease timeout.
 * - Manual recovery: Admins can retry or cancel failed jobs; both are audited.
 */

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueInput {
  orgId: string;
  type: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
  runAfter?: Date;
  createdBy?: string | null;
}

/** Enqueue inside the caller's tenant transaction so the job commits with the change that caused it. */
export async function enqueue(tx: Tx, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const inserted = await tx
    .insert(jobs)
    .values({
      orgId: input.orgId,
      type: input.type,
      payload: input.payload ?? {},
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? 5,
      runAfter: input.runAfter ?? new Date(),
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] })
    .returning({ id: jobs.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const [existing] = await tx
    .select({ id: jobs.id, orgId: jobs.orgId })
    .from(jobs)
    .where(and(eq(jobs.type, input.type), eq(jobs.idempotencyKey, input.idempotencyKey)));
  // RLS hides other tenants' rows, so a key collision across orgs surfaces here.
  if (!existing) throw new Error("Idempotency key already used by another tenant; include the org id in keys");
  return { id: existing.id, created: false };
}

export const LEASE_SECONDS = 300;

/** Claim the next runnable job. Returns null when the queue is empty. */
export async function claimNext(workerId: string, types?: string[]): Promise<JobRow | null> {
  return withSystem(async (tx) => {
    const typeFilter = types && types.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
    const res = await tx.execute(sql`
      update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, updated_at = now()
      where id = (
        select id from jobs
        where ((status = 'queued' and run_after <= now())
           or (status = 'running' and attempts < max_attempts and locked_at < now() - make_interval(secs => ${LEASE_SECONDS})))
        ${typeFilter}
        order by run_after
        for update skip locked
        limit 1
      )
      returning *`);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  });
}

function mapRow(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    orgId: (r.org_id as string | null) ?? null,
    type: r.type as string,
    payload: r.payload,
    status: r.status as JobRow["status"],
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    runAfter: new Date(r.run_after as string),
    lockedAt: r.locked_at ? new Date(r.locked_at as string) : null,
    lockedBy: (r.locked_by as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    idempotencyKey: r.idempotency_key as string,
    result: r.result ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
    finishedAt: r.finished_at ? new Date(r.finished_at as string) : null,
  };
}

/** Mark jobs whose worker died on their final attempt as failed (visible, recoverable). */
export async function sweepAbandoned(): Promise<number> {
  return withSystem(async (tx) => {
    const res = await tx.execute(sql`
      update jobs set status = 'failed', last_error = coalesce(last_error, 'Worker stopped responding during final attempt'),
        locked_at = null, locked_by = null, finished_at = now(), updated_at = now()
      where status = 'running' and attempts >= max_attempts and locked_at < now() - make_interval(secs => ${LEASE_SECONDS})
      returning id`);
    return res.rows.length;
  });
}

/** Errors that should not be retried (bad input, missing reference data, permission). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export function backoffSeconds(attempt: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempt - 1), 3600);
}

export async function completeJob(job: JobRow, workerId: string, result: unknown = null) {
  await withSystem((tx) =>
    tx
      .update(jobs)
      .set({ status: "succeeded", result: result as object, lockedAt: null, lockedBy: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId))),
  );
}

export async function failJob(job: JobRow, workerId: string, err: unknown) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const permanent = err instanceof PermanentJobError;
  const exhausted = job.attempts >= job.maxAttempts;
  await withSystem(async (tx) => {
    const terminal = permanent || exhausted;
    await tx
      .update(jobs)
      .set({
        status: terminal ? "failed" : "queued",
        lastError: message,
        lockedAt: null,
        lockedBy: null,
        runAfter: terminal ? job.runAfter : new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
        finishedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId)));
    if (terminal && job.orgId) {
      await audit(tx, {
        orgId: job.orgId,
        actorUserId: null,
        actorType: "system",
        action: "job.failed",
        entityType: "job",
        entityId: job.id,
        data: { type: job.type, attempts: job.attempts, permanent, error: message },
      });
    }
  });
}

/** Admin manual recovery: re-queue a failed or cancelled job with a fresh retry budget. */
export async function retryJob(actor: { userId: string; orgId: string; role: Role }, jobId: string) {
  assertCan(actor.role, "jobs.recover");
  return withTenant(actor.orgId, async (tx) => {
    const res = await tx
      .update(jobs)
      .set({ status: "queued", runAfter: new Date(), maxAttempts: sql`${jobs.attempts} + 3`, finishedAt: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, actor.orgId), inArray(jobs.status, ["failed", "cancelled"])))
      .returning({ id: jobs.id, type: jobs.type });
    if (!res[0]) throw new Error("Job not found or not in a recoverable state");
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "job.retried", entityType: "job", entityId: jobId, data: { type: res[0].type } });
  });
}

export async function cancelJob(actor: { userId: string; orgId: string; role: Role }, jobId: string) {
  assertCan(actor.role, "jobs.recover");
  return withTenant(actor.orgId, async (tx) => {
    const res = await tx
      .update(jobs)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, actor.orgId), inArray(jobs.status, ["queued", "failed"])))
      .returning({ id: jobs.id, type: jobs.type });
    if (!res[0]) throw new Error("Job not found or not cancellable");
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "job.cancelled", entityType: "job", entityId: jobId, data: { type: res[0].type } });
  });
}
